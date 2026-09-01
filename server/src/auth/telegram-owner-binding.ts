import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts, userRoles, users } from "../db/schema";

const LEGACY_OWNER_USER_ID = "dev-local-user";
const TELEGRAM_PROVIDER_ID = "telegram";
const TELEGRAM_ISSUER = "telegram";
const OWNER_BINDING_LOCK = "telegram-owner-binding:dev-local-user";
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const MAX_TELEGRAM_ID = (1n << 52n) - 1n;

export type TelegramOwnerBindingErrorCode =
  | "invalid_telegram_id"
  | "legacy_owner_missing"
  | "subject_conflict"
  | "target_conflict";

const ERROR_MESSAGES: Record<TelegramOwnerBindingErrorCode, string> = {
  invalid_telegram_id: "The Telegram owner ID is invalid.",
  legacy_owner_missing: "The retained owner account is not available.",
  subject_conflict: "That Telegram subject is already bound.",
  target_conflict: "The retained owner has another Telegram binding.",
};

/** A bounded, operator-safe failure that never includes the submitted ID or database details. */
export class TelegramOwnerBindingError extends Error {
  constructor(readonly code: TelegramOwnerBindingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TelegramOwnerBindingError";
  }
}

function canonicalTelegramId(value: string): string {
  if (
    value.length === 0 ||
    value.length > 16 ||
    !CANONICAL_POSITIVE_INTEGER.test(value)
  ) {
    throw new TelegramOwnerBindingError("invalid_telegram_id");
  }

  try {
    if (BigInt(value) > MAX_TELEGRAM_ID) {
      throw new TelegramOwnerBindingError("invalid_telegram_id");
    }
  } catch (error) {
    if (error instanceof TelegramOwnerBindingError) throw error;
    throw new TelegramOwnerBindingError("invalid_telegram_id");
  }
  return value;
}

/**
 * Parse exactly one ID read from stdin.
 *
 * Only the terminal's one trailing line ending is removed. General trimming would turn a pasted
 * space or a second line into a different identity, which is not acceptable for an owner binding.
 */
export function parseTelegramOwnerIdInput(input: string): string {
  if (typeof input !== "string") {
    throw new TelegramOwnerBindingError("invalid_telegram_id");
  }
  const value = input.endsWith("\r\n")
    ? input.slice(0, -2)
    : input.endsWith("\n")
      ? input.slice(0, -1)
      : input;
  if (value.includes("\n") || value.includes("\r")) {
    throw new TelegramOwnerBindingError("invalid_telegram_id");
  }
  return canonicalTelegramId(value);
}

export type TelegramOwnerBindingResult =
  | Readonly<{ outcome: "ready"; applied: false }>
  | Readonly<{ outcome: "bound"; applied: true }>
  | Readonly<{ outcome: "already_bound"; applied: boolean }>;

type TelegramOwnerBindingInput = Readonly<{
  telegramId: string;
  apply: boolean;
}>;

/**
 * Attach the immutable Telegram owner subject to the history-owning local user.
 *
 * The user row is only locked and inspected; it is never updated or replaced. The account binding
 * and exact administrator role are changed in the same transaction. A fixed target lock serialises
 * two configured subjects racing for the retained owner, while the account schema's unique
 * `(provider_id, account_id)` key remains the final authority for a subject racing in elsewhere.
 */
export async function bindTelegramOwner(
  database: Database,
  input: TelegramOwnerBindingInput,
): Promise<TelegramOwnerBindingResult> {
  const telegramId = canonicalTelegramId(input.telegramId);
  const subject = `${TELEGRAM_PROVIDER_ID}:${telegramId}`;
  // Runtime callers may be JavaScript rather than TypeScript. Only the literal boolean grants a
  // write; every malformed value degrades to the safe dry-run path.
  const apply = input.apply === true;

  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${OWNER_BINDING_LOCK}, 0))`,
    );

    const [owner] = await transaction
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, LEGACY_OWNER_USER_ID))
      .for("update");
    if (!owner) {
      throw new TelegramOwnerBindingError("legacy_owner_missing");
    }

    const [subjectBinding] = await transaction
      .select({ issuer: accounts.issuer, userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, TELEGRAM_PROVIDER_ID),
          eq(accounts.accountId, subject),
        ),
      )
      .limit(1);
    if (
      subjectBinding &&
      (subjectBinding.userId !== LEGACY_OWNER_USER_ID ||
        subjectBinding.issuer !== TELEGRAM_ISSUER)
    ) {
      throw new TelegramOwnerBindingError("subject_conflict");
    }

    const targetBindings = await transaction
      .select({ accountId: accounts.accountId, issuer: accounts.issuer })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, TELEGRAM_PROVIDER_ID),
          eq(accounts.userId, LEGACY_OWNER_USER_ID),
        ),
      );
    if (
      targetBindings.some(
        (binding) =>
          binding.accountId !== subject || binding.issuer !== TELEGRAM_ISSUER,
      )
    ) {
      throw new TelegramOwnerBindingError("target_conflict");
    }

    const roles = await transaction
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, LEGACY_OWNER_USER_ID));
    const roleChanged = roles.length !== 1 || roles[0]?.role !== "admin";

    if (!apply) {
      return subjectBinding && !roleChanged
        ? { outcome: "already_bound", applied: false }
        : { outcome: "ready", applied: false };
    }

    let insertedBinding = false;
    if (!subjectBinding) {
      const inserted = await transaction
        .insert(accounts)
        .values({
          id: randomUUID(),
          accountId: subject,
          providerId: TELEGRAM_PROVIDER_ID,
          issuer: TELEGRAM_ISSUER,
          userId: LEGACY_OWNER_USER_ID,
        })
        .onConflictDoNothing()
        .returning({ userId: accounts.userId });
      insertedBinding = inserted.length === 1;

      if (!insertedBinding) {
        const [winner] = await transaction
          .select({ issuer: accounts.issuer, userId: accounts.userId })
          .from(accounts)
          .where(
            and(
              eq(accounts.providerId, TELEGRAM_PROVIDER_ID),
              eq(accounts.accountId, subject),
            ),
          )
          .limit(1);
        if (
          !winner ||
          winner.userId !== LEGACY_OWNER_USER_ID ||
          winner.issuer !== TELEGRAM_ISSUER
        ) {
          throw new TelegramOwnerBindingError("subject_conflict");
        }
      }
    }

    // Check the target again after the unique-key insert. A writer that does not use our advisory
    // lock still cannot leave this transaction committing a second Telegram subject for the owner.
    const finalTargetBindings = await transaction
      .select({ accountId: accounts.accountId, issuer: accounts.issuer })
      .from(accounts)
      .where(
        and(
          eq(accounts.providerId, TELEGRAM_PROVIDER_ID),
          eq(accounts.userId, LEGACY_OWNER_USER_ID),
        ),
      );
    if (
      finalTargetBindings.length !== 1 ||
      finalTargetBindings[0]?.accountId !== subject ||
      finalTargetBindings[0]?.issuer !== TELEGRAM_ISSUER
    ) {
      throw new TelegramOwnerBindingError("target_conflict");
    }

    await transaction
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.userId, LEGACY_OWNER_USER_ID),
          ne(userRoles.role, "admin"),
        ),
      );
    await transaction
      .insert(userRoles)
      .values({ userId: LEGACY_OWNER_USER_ID, role: "admin" })
      .onConflictDoNothing();

    if (insertedBinding) return { outcome: "bound", applied: true };
    return { outcome: "already_bound", applied: roleChanged };
  });
}
