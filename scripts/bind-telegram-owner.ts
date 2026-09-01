import {
  bindTelegramOwner,
  parseTelegramOwnerIdInput,
  TelegramOwnerBindingError,
} from "../server/src/auth/telegram-owner-binding";
import { createDatabase } from "../server/src/db/client";

const MAX_STDIN_BYTES = 64;

type TelegramOwnerBindingCliErrorCode =
  | "invalid_arguments"
  | "invalid_stdin"
  | "invalid_configuration"
  | "owner_not_configured"
  | "database_not_configured";

const CLI_ERROR_MESSAGES: Record<TelegramOwnerBindingCliErrorCode, string> = {
  invalid_arguments:
    "Only --apply or --help may be supplied. The owner ID must come from stdin.",
  invalid_stdin:
    "Exactly one canonical Telegram owner ID is required on stdin.",
  invalid_configuration: "The protected owner configuration is invalid.",
  owner_not_configured: "The submitted ID is not configured as an owner.",
  database_not_configured: "The database connection is not configured.",
};

/** A safe operator-facing error whose text contains no ID or environment value. */
export class TelegramOwnerBindingCliError extends Error {
  constructor(readonly code: TelegramOwnerBindingCliErrorCode) {
    super(CLI_ERROR_MESSAGES[code]);
    this.name = "TelegramOwnerBindingCliError";
  }
}

export function parseTelegramOwnerBindingArguments(
  arguments_: readonly string[],
): Readonly<{ apply: boolean; help: boolean }> {
  if (arguments_.length === 0) return { apply: false, help: false };
  if (arguments_.length !== 1) {
    throw new TelegramOwnerBindingCliError("invalid_arguments");
  }
  if (arguments_[0] === "--apply") return { apply: true, help: false };
  if (arguments_[0] === "--help") return { apply: false, help: true };
  throw new TelegramOwnerBindingCliError("invalid_arguments");
}

function configuredOwnerIds(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") {
    throw new TelegramOwnerBindingCliError("invalid_configuration");
  }
  const ids = new Set<string>();
  try {
    for (const candidate of value.split(",")) {
      const id = parseTelegramOwnerIdInput(candidate.trim());
      if (ids.has(id)) {
        throw new TelegramOwnerBindingCliError("invalid_configuration");
      }
      ids.add(id);
    }
  } catch (error) {
    if (error instanceof TelegramOwnerBindingCliError) throw error;
    throw new TelegramOwnerBindingCliError("invalid_configuration");
  }
  return ids;
}

/** Prove the stdin subject is one the protected deployment configuration names as an owner. */
export function assertConfiguredTelegramOwnerId(
  telegramId: string,
  configuredValue: string | undefined,
): string {
  const ids = configuredOwnerIds(configuredValue);
  if (!ids.has(telegramId)) {
    throw new TelegramOwnerBindingCliError("owner_not_configured");
  }
  return telegramId;
}

/** Read stdin once with a hard byte cap before decoding or parsing it. */
export async function readTelegramOwnerIdFromStdin(
  stream: ReadableStream<Uint8Array> = Bun.stdin.stream(),
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (!Number.isSafeInteger(size) || size > MAX_STDIN_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new TelegramOwnerBindingCliError("invalid_stdin");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof TelegramOwnerBindingCliError) throw error;
    throw new TelegramOwnerBindingCliError("invalid_stdin");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A stream that ignored cancellation can retain its lock; the command still fails closed.
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return parseTelegramOwnerIdInput(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new TelegramOwnerBindingCliError("invalid_stdin");
  }
}

const HELP = `Usage:
  bun run bind:telegram-owner
  bun run bind:telegram-owner -- --apply

The command is a dry-run unless --apply is supplied.
The Telegram owner ID is always read from bounded stdin; it is never a command argument.`;

async function run(): Promise<number> {
  let options: Readonly<{ apply: boolean; help: boolean }>;
  try {
    options = parseTelegramOwnerBindingArguments(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof TelegramOwnerBindingCliError
        ? error.message
        : "The owner binding command is invalid.",
    );
    return 2;
  }

  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    console.error(CLI_ERROR_MESSAGES.database_not_configured);
    return 1;
  }

  console.error("Enter the configured Telegram owner ID, then press Enter:");
  let telegramId: string;
  try {
    telegramId = assertConfiguredTelegramOwnerId(
      await readTelegramOwnerIdFromStdin(),
      process.env.TELEGRAM_OWNER_USER_IDS,
    );
  } catch (error) {
    console.error(
      error instanceof TelegramOwnerBindingCliError
        ? error.message
        : CLI_ERROR_MESSAGES.invalid_stdin,
    );
    return 1;
  }

  let database: ReturnType<typeof createDatabase>;
  try {
    database = createDatabase(databaseUrl, { max: 2 });
  } catch {
    console.error("The database connection could not be prepared.");
    return 1;
  }
  try {
    const result = await bindTelegramOwner(database, {
      telegramId,
      apply: options.apply,
    });
    if (result.outcome === "ready") {
      console.log("Dry run succeeded. No changes were made.");
    } else if (result.outcome === "bound") {
      console.log("Telegram owner binding and administrator role applied.");
    } else if (result.applied) {
      console.log(
        "The Telegram owner binding was already present; the administrator role was repaired.",
      );
    } else {
      console.log(
        "Telegram owner binding is already correct; no changes were made.",
      );
    }
    return 0;
  } catch (error) {
    console.error(
      error instanceof TelegramOwnerBindingError
        ? error.message
        : "Telegram owner binding failed.",
    );
    return 1;
  } finally {
    await database.$client.close().catch(() => undefined);
  }
}

if (import.meta.main) {
  process.exitCode = await run();
}
