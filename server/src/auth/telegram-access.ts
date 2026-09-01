import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { accounts, revokedAccess, sessions, users } from "../db/schema";

const TELEGRAM_PROVIDER_ID = "telegram";
const TELEGRAM_ISSUER = "telegram";
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const MAX_TELEGRAM_ID = (1n << 52n) - 1n;

export type TelegramAccessReconciliationErrorCode =
  | "owner_configuration_invalid"
  | "owner_binding_missing";

const ERROR_MESSAGES: Record<TelegramAccessReconciliationErrorCode, string> = {
  owner_configuration_invalid:
    "Telegram owner access configuration is invalid.",
  owner_binding_missing:
    "No configured Telegram owner has a live account binding.",
};

/** A boot-safe error that never includes a Telegram ID, email or database value. */
export class TelegramAccessReconciliationError extends Error {
  constructor(readonly code: TelegramAccessReconciliationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "TelegramAccessReconciliationError";
  }
}

type ReconciliationInput = Readonly<{
  allowedUserIds: ReadonlySet<string>;
  ownerUserIds: ReadonlySet<string>;
}>;

export type TelegramAccessReconciliationResult = Readonly<{
  activeOwners: number;
  boundAccounts: number;
  sessionsRevoked: number;
}>;

function isCanonicalTelegramId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16 ||
    !CANONICAL_POSITIVE_INTEGER.test(value)
  ) {
    return false;
  }
  try {
    return BigInt(value) <= MAX_TELEGRAM_ID;
  } catch {
    return false;
  }
}

function validateConfiguration(input: ReconciliationInput): void {
  if (
    !(input.allowedUserIds instanceof Set) ||
    !(input.ownerUserIds instanceof Set) ||
    input.ownerUserIds.size === 0
  ) {
    throw new TelegramAccessReconciliationError("owner_configuration_invalid");
  }
  for (const id of input.allowedUserIds) {
    if (!isCanonicalTelegramId(id)) {
      throw new TelegramAccessReconciliationError(
        "owner_configuration_invalid",
      );
    }
  }
  for (const id of input.ownerUserIds) {
    if (!isCanonicalTelegramId(id) || !input.allowedUserIds.has(id)) {
      throw new TelegramAccessReconciliationError(
        "owner_configuration_invalid",
      );
    }
  }
}

function telegramIdFromAccount(subject: string): string | null {
  const prefix = `${TELEGRAM_PROVIDER_ID}:`;
  if (!subject.startsWith(prefix)) return null;
  const id = subject.slice(prefix.length);
  return isCanonicalTelegramId(id) ? id : null;
}

/**
 * End sessions that no longer have configured Telegram access before the server accepts traffic.
 *
 * Configuration removal is intentionally not copied into `revoked_access`: adding an ID back to
 * protected configuration may restore configuration access, while an administrator's explicit
 * database revocation must remain sticky. Both conditions still delete current sessions here, and
 * the callback checks the current allowlist again before every future session.
 */
export async function reconcileTelegramAccess(
  database: Database,
  input: ReconciliationInput,
): Promise<TelegramAccessReconciliationResult> {
  validateConfiguration(input);
  // Snapshot mutable Set implementations before the first await so one reconciliation observes one
  // coherent configuration even if an operator-side test adapter replaces its source afterwards.
  const allowedUserIds = new Set(input.allowedUserIds);
  const ownerUserIds = new Set(input.ownerUserIds);

  return database.transaction(async (transaction) => {
    const bindings = await transaction
      .select({
        accountId: accounts.accountId,
        issuer: accounts.issuer,
        userId: accounts.userId,
        explicitlyRevoked: sql<boolean>`${revokedAccess.email} is not null`,
      })
      .from(accounts)
      .innerJoin(users, eq(users.id, accounts.userId))
      .leftJoin(
        revokedAccess,
        eq(revokedAccess.email, sql`lower(${users.email})`),
      )
      .where(eq(accounts.providerId, TELEGRAM_PROVIDER_ID));

    const usersToRevoke = new Set<string>();
    let activeOwners = 0;
    for (const binding of bindings) {
      const id = telegramIdFromAccount(binding.accountId);
      const hasConfiguredAccess =
        binding.issuer === TELEGRAM_ISSUER &&
        id !== null &&
        allowedUserIds.has(id);
      if (!hasConfiguredAccess || binding.explicitlyRevoked) {
        usersToRevoke.add(binding.userId);
        continue;
      }
      if (id !== null && ownerUserIds.has(id)) activeOwners += 1;
    }

    if (activeOwners === 0) {
      throw new TelegramAccessReconciliationError("owner_binding_missing");
    }

    const revokedSessions =
      usersToRevoke.size === 0
        ? []
        : await transaction
            .delete(sessions)
            .where(inArray(sessions.userId, [...usersToRevoke]))
            .returning({ id: sessions.id });

    return {
      activeOwners,
      boundAccounts: bindings.length,
      sessionsRevoked: revokedSessions.length,
    };
  });
}
