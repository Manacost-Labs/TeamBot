const encoder = new TextEncoder();
const decoder = new TextDecoder();

type TokenKind = "bootstrap" | "session";
type Payload = { kind: TokenKind; sub: string; exp: number; nonce: string };

export async function verifyToken(
  token: string,
  secret: string,
  expectedKind: TokenKind,
  now = Math.floor(Date.now() / 1000),
): Promise<Payload | null> {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) return null;
  try {
    const key = await importKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(encodedSignature),
      encoder.encode(encodedPayload),
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(encodedPayload))) as Partial<Payload>;
    if (
      payload.kind !== expectedKind ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      typeof payload.nonce !== "string"
    ) return null;
    return payload as Payload;
  } catch {
    return null;
  }
}

export async function createSessionToken(
  subject: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload: Payload = {
    kind: "session",
    sub: subject,
    exp: now + 8 * 60 * 60,
    nonce: crypto.randomUUID(),
  };
  const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(secret, ["sign"]),
    encoder.encode(encodedPayload),
  );
  return `${encodedPayload}.${toBase64Url(new Uint8Array(signature))}`;
}

async function importKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}
