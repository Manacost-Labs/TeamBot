import { describe, expect, test } from "bun:test";
import { createSessionToken, verifyToken } from "../src/session";

const secret = "a sufficiently long test secret with 32 bytes";

describe("edge session tokens", () => {
  test("round-trips a valid session", async () => {
    const token = await createSessionToken("chatgpt-user", secret, 100);
    expect(await verifyToken(token, secret, "session", 101)).toMatchObject({
      kind: "session",
      sub: "chatgpt-user",
    });
  });

  test("rejects tampering and the wrong token kind", async () => {
    const token = await createSessionToken("chatgpt-user", secret, 100);
    expect(await verifyToken(`${token}x`, secret, "session", 101)).toBeNull();
    expect(await verifyToken(token, secret, "bootstrap", 101)).toBeNull();
  });
});
