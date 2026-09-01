import { constants } from "node:fs";
import { chmod, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodexRuntimeProfile,
  type CreateCodexRuntimeProfileOptions,
  createCodexRuntimeProfile,
} from "./runtime-profile";

const PRIVATE_FILE_MODE = 0o600;
const MAX_AUTH_DOCUMENT_BYTES = 256 * 1_024;
const MAX_TOKEN_CHARACTERS = 192 * 1_024;

export class ChatGptProfileUnavailableError extends Error {
  constructor() {
    super(
      "Personal ChatGPT connection is unavailable. Reconnect ChatGPT in Settings.",
    );
    this.name = "ChatGptProfileUnavailableError";
  }
}

type ChatGptAuthDocument = Readonly<{
  source: string;
  sensitiveValues: readonly string[];
}>;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function privateToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_CHARACTERS &&
    value.trim() === value
  );
}

/** Validate the narrow stable portion of Codex's evolving auth.json contract. */
export function parseChatGptAuthDocument(
  value: unknown,
): ChatGptAuthDocument | null {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > MAX_AUTH_DOCUMENT_BYTES ||
    Buffer.byteLength(value, "utf8") > MAX_AUTH_DOCUMENT_BYTES
  ) {
    return null;
  }

  let document: Record<string, unknown> | undefined;
  try {
    document = objectValue(JSON.parse(value));
  } catch {
    return null;
  }
  const tokens = objectValue(document?.tokens);
  if (
    document?.auth_mode !== "chatgpt" ||
    !tokens ||
    !privateToken(tokens.access_token) ||
    !privateToken(tokens.refresh_token)
  ) {
    return null;
  }

  const tokenValues = Object.values(tokens).filter(privateToken);
  return Object.freeze({
    source: value,
    // Longest first makes a nested value impossible to leave inside a partly redacted document.
    sensitiveValues: Object.freeze(
      [...new Set([value, ...tokenValues])].sort(
        (left, right) => right.length - left.length,
      ),
    ),
  });
}

export type ChatGptRuntimeProfile = CodexRuntimeProfile &
  Readonly<{
    sensitiveValues: readonly string[];
    readChangedAuthDocument(): Promise<string | null>;
  }>;

export type CreateChatGptRuntimeProfileOptions =
  CreateCodexRuntimeProfileOptions & Readonly<{ authDocument: string }>;

async function readSafeAuthDocument(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    const uid = process.getuid?.();
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      uid === undefined ||
      details.uid !== uid ||
      (details.mode & 0o777) !== PRIVATE_FILE_MODE ||
      details.size < 2 ||
      details.size > MAX_AUTH_DOCUMENT_BYTES
    ) {
      throw new ChatGptProfileUnavailableError();
    }
    const authDocument = await handle.readFile({ encoding: "utf8" });
    if (!parseChatGptAuthDocument(authDocument)) {
      throw new ChatGptProfileUnavailableError();
    }
    return authDocument;
  } catch {
    throw new ChatGptProfileUnavailableError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Materialise one actor-owned auth document in the same task-owned home as the trusted config.
 *
 * No host auth path or HOME is inherited. The document is accepted before the profile is created,
 * then written exactly once with owner-only permissions. Reading after child exit uses O_NOFOLLOW
 * and validates the refreshed document again before it can cross the internal refresh boundary.
 */
export async function createChatGptRuntimeProfile(
  options: CreateChatGptRuntimeProfileOptions,
): Promise<ChatGptRuntimeProfile> {
  const initial = parseChatGptAuthDocument(options.authDocument);
  if (!initial) throw new ChatGptProfileUnavailableError();

  const profile = await createCodexRuntimeProfile(options);
  const authPath = join(profile.codexHome, "auth.json");
  try {
    await writeFile(authPath, initial.source, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(authPath, PRIVATE_FILE_MODE);
    return {
      ...profile,
      sensitiveValues: initial.sensitiveValues,
      async readChangedAuthDocument() {
        const current = await readSafeAuthDocument(authPath);
        return current === initial.source ? null : current;
      },
      dispose: profile.dispose,
    };
  } catch (error) {
    await profile.dispose().catch(() => undefined);
    throw error instanceof ChatGptProfileUnavailableError
      ? error
      : new ChatGptProfileUnavailableError();
  }
}
