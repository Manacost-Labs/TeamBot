import { describe, expect, test } from "bun:test";
import {
  InMemoryTelegramLoginOneTimeStorage,
  TelegramLoginError,
  TelegramLoginProofReplayStore,
  TelegramLoginStateStore,
  verifyTelegramLoginPayload,
} from "../src/auth/telegram-login";

const SYNTHETIC_BOT_TOKEN = "123456789:synthetic-unit-test-token";
const AUTH_DATE_SECONDS = 1_700_000_000;
const SYNTHETIC_LOGIN = new URLSearchParams({
  id: "1234567890123",
  first_name: "Ada",
  last_name: "Lovelace",
  username: "ada_test",
  photo_url: "https://t.me/i/userpic/320/ada.jpg",
  auth_date: String(AUTH_DATE_SECONDS),
  hash: "866decfdfabab5c7103cc66790ee53505a00efc8c37f2d4859ca091eb3ab31f0",
});

function cloneLogin(): URLSearchParams {
  return new URLSearchParams(SYNTHETIC_LOGIN);
}

function captureTelegramError(operation: () => unknown): TelegramLoginError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramLoginError);
    const loginError = error as TelegramLoginError;
    expect(loginError.name).toBe("TelegramLoginError");
    expect(loginError.code).toBe("INVALID_TELEGRAM_LOGIN");
    expect(loginError.message).toBe("Telegram login failed.");
    return loginError;
  }
  throw new Error("Expected TelegramLoginError");
}

async function captureTelegramErrorAsync(
  operation: () => Promise<unknown>,
): Promise<TelegramLoginError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TelegramLoginError);
    const loginError = error as TelegramLoginError;
    expect(loginError.name).toBe("TelegramLoginError");
    expect(loginError.code).toBe("INVALID_TELEGRAM_LOGIN");
    expect(loginError.message).toBe("Telegram login failed.");
    return loginError;
  }
  throw new Error("Expected TelegramLoginError");
}

function verify(params: URLSearchParams, nowSeconds = AUTH_DATE_SECONDS) {
  return verifyTelegramLoginPayload(params, {
    botToken: SYNTHETIC_BOT_TOKEN,
    nowSeconds,
  });
}

describe("Telegram Login Widget payload verification", () => {
  test("accepts a correctly signed synthetic Telegram fixture", () => {
    expect(verify(cloneLogin())).toEqual({
      id: "1234567890123",
      firstName: "Ada",
      lastName: "Lovelace",
      username: "ada_test",
      photoUrl: "https://t.me/i/userpic/320/ada.jpg",
      authDate: AUTH_DATE_SECONDS,
      replayKey:
        "ac8c40f123d9e33491313d41437d9ff763ca4fad8e52908bc7cc271f3544b270",
    });
  });

  test.each([
    ["id", "1234567890124"],
    ["first_name", "Grace"],
    ["last_name", "Byron"],
    ["username", "changed_user"],
    ["photo_url", "https://t.me/i/userpic/320/changed.jpg"],
    ["auth_date", String(AUTH_DATE_SECONDS - 1)],
  ])("rejects a modified signed %s field", (field, replacement) => {
    const params = cloneLogin();
    params.set(field, replacement);

    captureTelegramError(() => verify(params));
  });

  test("accepts an auth_date exactly five minutes old", () => {
    expect(verify(cloneLogin(), AUTH_DATE_SECONDS + 300).id).toBe(
      "1234567890123",
    );
  });

  test("rejects an auth_date older than five minutes", () => {
    captureTelegramError(() => verify(cloneLogin(), AUTH_DATE_SECONDS + 301));
  });

  test("rejects a future auth_date", () => {
    captureTelegramError(() => verify(cloneLogin(), AUTH_DATE_SECONDS - 1));
  });

  test.each(["id", "first_name", "auth_date", "hash"])(
    "rejects a missing required %s field",
    (field) => {
      const params = cloneLogin();
      params.delete(field);

      captureTelegramError(() => verify(params));
    },
  );

  test("rejects an unknown field", () => {
    const params = cloneLogin();
    params.set("return_to", "https://attacker.example");

    captureTelegramError(() => verify(params));
  });

  test("rejects a duplicate field", () => {
    const params = cloneLogin();
    params.append("id", "1234567890123");

    captureTelegramError(() => verify(params));
  });

  test.each([
    ["id", "01"],
    ["id", "0"],
    ["id", "-1"],
    ["id", "+1"],
    ["id", "1.0"],
    ["id", "4503599627370496"],
    ["id", "9".repeat(1_024)],
    ["first_name", ""],
    ["first_name", "Ada\0Injected"],
    ["username", "invalid-user"],
    ["photo_url", "http://t.me/i/userpic/320/ada.jpg"],
    ["auth_date", "01700000000"],
    ["auth_date", "not-a-number"],
    ["hash", "866decfd"],
    ["hash", "a"],
    ["hash", "a".repeat(63)],
    ["hash", "a".repeat(65)],
    ["hash", "g".repeat(64)],
    [
      "hash",
      "866DECFDFABAB5C7103CC66790EE53505A00EFC8C37F2D4859CA091EB3AB31F0",
    ],
  ])("rejects malformed %s", (field, replacement) => {
    const params = cloneLogin();
    params.set(field, replacement);

    captureTelegramError(() => verify(params));
  });

  test("uses one generic error without leaking a payload or bot token", () => {
    const params = cloneLogin();
    params.set("hash", "short");

    const error = captureTelegramError(() => verify(params));
    const serialized = `${error.name} ${error.message} ${JSON.stringify(error)}`;
    expect(serialized).not.toContain(SYNTHETIC_BOT_TOKEN);
    expect(serialized).not.toContain("1234567890123");
    expect(serialized).not.toContain("short");
  });
});

describe("one-time Telegram login state", () => {
  const TRUSTED_ORIGIN = "https://work.kolodahearthstone.com";
  let nowMilliseconds = 1_700_000_000_000;

  function createStore(storage = new InMemoryTelegramLoginOneTimeStorage()) {
    nowMilliseconds = 1_700_000_000_000;
    return new TelegramLoginStateStore({
      trustedOrigin: TRUSTED_ORIGIN,
      allowedReturnPaths: ["/", "/settings"],
      ttlMilliseconds: 120_000,
      now: () => nowMilliseconds,
      storage,
    });
  }

  test.each(["/%2f%2fevil", "/%5c%5cattacker.example", "/bad%encoding"])(
    "rejects encoded custom return path %s during configuration",
    (returnPath) => {
      expect(
        () =>
          new TelegramLoginStateStore({
            trustedOrigin: TRUSTED_ORIGIN,
            allowedReturnPaths: [returnPath],
          }),
      ).toThrow("allowedReturnPaths must contain safe local paths");
    },
  );

  test("issues cryptographically shaped unique states and consumes one once", async () => {
    const store = createStore();
    const first = await store.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/settings",
    });
    const second = await store.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/",
    });

    expect(first.state).toMatch(/^[a-f0-9]{64}$/);
    expect(first.browserBinding).toMatch(/^[a-f0-9]{64}$/);
    expect(second.state).toMatch(/^[a-f0-9]{64}$/);
    expect(second.browserBinding).toMatch(/^[a-f0-9]{64}$/);
    expect(second.state).not.toBe(first.state);
    expect(second.browserBinding).not.toBe(first.browserBinding);
    expect(
      await store.consume({
        state: first.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: first.browserBinding,
      }),
    ).toBe("/settings");
    await captureTelegramErrorAsync(() =>
      store.consume({
        state: first.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: first.browserBinding,
      }),
    );
  });

  test.each([
    "//attacker.example",
    "https://attacker.example/settings",
    "/settings?next=https://attacker.example",
    "/settings#fragment",
    "/%2f%2fevil",
    "/not-allowlisted",
    "\\attacker.example",
  ])("refuses unsafe or non-allowlisted return path %s", async (returnPath) => {
    const store = createStore();

    await captureTelegramErrorAsync(() =>
      store.issue({
        requestOrigin: TRUSTED_ORIGIN,
        returnPath,
      }),
    );
  });

  test("binds state to the exact trusted origin", async () => {
    const store = createStore();

    await captureTelegramErrorAsync(() =>
      store.issue({
        requestOrigin: "https://work.kolodahearthstone.com.attacker.example",
        returnPath: "/",
      }),
    );
  });

  test("rejects and reserves a state consumed from a different origin", async () => {
    const store = createStore();
    const issued = await store.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/",
    });

    await captureTelegramErrorAsync(() =>
      store.consume({
        state: issued.state,
        requestOrigin: "https://attacker.example",
        browserBinding: issued.browserBinding,
      }),
    );
    await captureTelegramErrorAsync(() =>
      store.consume({
        state: issued.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: issued.browserBinding,
      }),
    );
  });

  test("stores the return path server-side instead of accepting it at consume time", async () => {
    const store = createStore();
    const issued = await store.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/settings",
    });

    expect(
      await store.consume({
        state: issued.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: issued.browserBinding,
      }),
    ).toBe("/settings");
  });

  test("binds state to the browser and reserves a failed matching state", async () => {
    const store = createStore();
    const issued = await store.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/",
    });

    await captureTelegramErrorAsync(() =>
      store.consume({
        state: issued.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: "0".repeat(64),
      }),
    );
    await captureTelegramErrorAsync(() =>
      store.consume({
        state: issued.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: issued.browserBinding,
      }),
    );
  });

  test("expires state after the configured short lifetime", async () => {
    const store = createStore();
    const issued = await store.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/",
    });
    nowMilliseconds += 120_000;

    await captureTelegramErrorAsync(() =>
      store.consume({
        state: issued.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: issued.browserBinding,
      }),
    );
  });

  test("can consume state through another service instance sharing atomic storage", async () => {
    const storage = new InMemoryTelegramLoginOneTimeStorage();
    const issuer = createStore(storage);
    const issued = await issuer.issue({
      requestOrigin: TRUSTED_ORIGIN,
      returnPath: "/settings",
    });
    const consumer = createStore(storage);

    await expect(
      consumer.consume({
        state: issued.state,
        requestOrigin: TRUSTED_ORIGIN,
        browserBinding: issued.browserBinding,
      }),
    ).resolves.toBe("/settings");
  });
});

describe("Telegram proof replay reservation", () => {
  test("allows exactly one concurrent reservation for an opaque replay key", async () => {
    const storage = new InMemoryTelegramLoginOneTimeStorage();
    const firstReplica = new TelegramLoginProofReplayStore({
      now: () => 1_700_000_000_000,
      storage,
    });
    const secondReplica = new TelegramLoginProofReplayStore({
      now: () => 1_700_000_000_000,
      storage,
    });
    const replayKey = verify(cloneLogin()).replayKey;

    const results = await Promise.allSettled([
      firstReplica.reserve(replayKey),
      secondReplica.reserve(replayKey),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(TelegramLoginError);
    }
  });

  test.each(["", "a", "a".repeat(63), "a".repeat(65), "g".repeat(64)])(
    "rejects malformed replay key %s generically",
    async (replayKey) => {
      const replayStore = new TelegramLoginProofReplayStore();

      await captureTelegramErrorAsync(() => replayStore.reserve(replayKey));
    },
  );
});
