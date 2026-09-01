import { and, eq, isNull, sql } from "drizzle-orm";
import { decryptSecret } from "../credentials";
import type { Database } from "../db/client";
import {
  credentials,
  personalAiCredentialLeases,
  userAiConnections,
} from "../db/schema";

const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1_000;
const MAX_LEASE_TTL_MS = 10 * 60 * 1_000;
const MAX_ACTOR_ID_CHARACTERS = 256;
const MAX_BOT_ID_CHARACTERS = 256;
const MAX_RUN_ID_CHARACTERS = 512;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type PersonalAiRuntimeCredential =
  | Readonly<{ provider: "openrouter"; apiKey: string }>
  | Readonly<{ provider: "chatgpt"; authDocument: string }>;

export type PersonalAiCredentialLeaseService = Readonly<{
  mint: (input: {
    actorUserId: string;
    botId: string;
    runId: string;
  }) => Promise<string>;
  redeem: (input: {
    lease: string;
    actorUserId: string;
    botId: string;
    runId: string;
  }) => Promise<PersonalAiRuntimeCredential>;
}>;

/** Safe signal for Task 17 to turn into the Settings guidance before dialling an agent. */
export class PersonalAiConnectionRequiredError extends Error {
  constructor() {
    super("An active personal AI connection is required.");
    this.name = "PersonalAiConnectionRequiredError";
  }
}

/**
 * Every unusable lease has one outward meaning.
 *
 * In particular, callers cannot distinguish a guessed id from an expired, redeemed, disconnected
 * or differently-owned lease. None of the identifiers or credential state is copied into the
 * message, which is safe to return across the internal HTTP boundary.
 */
export class PersonalAiCredentialLeaseRefusedError extends Error {
  constructor() {
    super("Credential lease is unavailable.");
    this.name = "PersonalAiCredentialLeaseRefusedError";
  }
}

function boundedIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value
  );
}

function validRun(input: {
  actorUserId: unknown;
  botId: unknown;
  runId: unknown;
}) {
  return (
    boundedIdentity(input.actorUserId, MAX_ACTOR_ID_CHARACTERS) &&
    boundedIdentity(input.botId, MAX_BOT_ID_CHARACTERS) &&
    boundedIdentity(input.runId, MAX_RUN_ID_CHARACTERS)
  );
}

function uniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    cause?: { code?: unknown; errno?: unknown };
  };
  return [
    candidate.code,
    candidate.errno,
    candidate.cause?.code,
    candidate.cause?.errno,
  ].includes("23505");
}

async function lockActor(transaction: Transaction, actorUserId: string) {
  // The connection store takes the same transaction-scoped lock before replacement/disconnect.
  // Mint therefore observes one complete connection generation rather than a pointer being rotated
  // while its lease row is written.
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${actorUserId}, 0))`,
  );
}

function runtimeCredential(
  provider: "chatgpt" | "openrouter",
  plaintext: string,
): PersonalAiRuntimeCredential {
  return provider === "openrouter"
    ? { provider, apiKey: plaintext }
    : { provider, authDocument: plaintext };
}

/**
 * Short-lived, single-use delivery of one actor's current personal provider credential.
 *
 * Mint persists only database identifiers and the database's expiry timestamp. Redemption locks the
 * exact lease, then locks and revalidates the connection plus vault row before marking it spent.
 * Decryption stays inside the transaction callback: if it fails, the redemption update rolls back.
 */
export function createPersonalAiCredentialLeaseService(input: {
  database: Database;
  encryptionKey: string;
  leaseTtlMs?: number;
}): PersonalAiCredentialLeaseService {
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (
    !Number.isSafeInteger(leaseTtlMs) ||
    leaseTtlMs < 1_000 ||
    leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new Error("Personal AI credential lease lifetime is invalid.");
  }

  return Object.freeze({
    async mint(mintInput) {
      if (!validRun(mintInput)) {
        throw new PersonalAiCredentialLeaseRefusedError();
      }

      try {
        return await input.database.transaction(async (transaction) => {
          await lockActor(transaction, mintInput.actorUserId);
          const [connection] = await transaction
            .select({ credentialId: userAiConnections.credentialId })
            .from(userAiConnections)
            .innerJoin(
              credentials,
              and(
                eq(credentials.id, userAiConnections.credentialId),
                eq(credentials.kind, "model"),
                sql`${credentials.provider} = ${userAiConnections.provider}::text`,
                isNull(credentials.revokedAt),
              ),
            )
            .where(
              and(
                eq(userAiConnections.userId, mintInput.actorUserId),
                eq(userAiConnections.state, "active"),
                isNull(userAiConnections.disconnectedAt),
              ),
            )
            .for("update");
          if (!connection) throw new PersonalAiConnectionRequiredError();

          const [lease] = await transaction
            .insert(personalAiCredentialLeases)
            .values({
              userId: mintInput.actorUserId,
              botId: mintInput.botId,
              runId: mintInput.runId,
              credentialId: connection.credentialId,
              // PostgreSQL owns both sides of the expiry comparison. Replica clock skew cannot
              // mint a lease that arrives expired, or keep one alive past the database's decision.
              expiresAt: sql`now() + (${leaseTtlMs} * interval '1 millisecond')`,
            })
            .returning({ id: personalAiCredentialLeases.id });
          if (!lease) throw new Error("Credential lease could not be stored.");
          return lease.id;
        });
      } catch (error) {
        // `run_id` is unique. A collision must not reveal whether that run already has a lease or
        // which actor/Bot it belongs to.
        if (uniqueViolation(error)) {
          throw new PersonalAiCredentialLeaseRefusedError();
        }
        throw error;
      }
    },

    async redeem(redeemInput) {
      if (!UUID.test(redeemInput.lease) || !validRun(redeemInput)) {
        throw new PersonalAiCredentialLeaseRefusedError();
      }

      return input.database.transaction(async (transaction) => {
        const [lease] = await transaction
          .select({
            id: personalAiCredentialLeases.id,
            credentialId: personalAiCredentialLeases.credentialId,
          })
          .from(personalAiCredentialLeases)
          .where(
            and(
              eq(personalAiCredentialLeases.id, redeemInput.lease),
              eq(personalAiCredentialLeases.userId, redeemInput.actorUserId),
              eq(personalAiCredentialLeases.botId, redeemInput.botId),
              eq(personalAiCredentialLeases.runId, redeemInput.runId),
              isNull(personalAiCredentialLeases.redeemedAt),
              sql`${personalAiCredentialLeases.expiresAt} > now()`,
            ),
          )
          .for("update");
        if (!lease) throw new PersonalAiCredentialLeaseRefusedError();

        const [connection] = await transaction
          .select({
            provider: userAiConnections.provider,
            encryptedValue: credentials.encryptedValue,
          })
          .from(userAiConnections)
          .innerJoin(
            credentials,
            and(
              eq(credentials.id, userAiConnections.credentialId),
              eq(credentials.id, lease.credentialId),
              eq(credentials.kind, "model"),
              sql`${credentials.provider} = ${userAiConnections.provider}::text`,
              isNull(credentials.revokedAt),
            ),
          )
          .where(
            and(
              eq(userAiConnections.userId, redeemInput.actorUserId),
              eq(userAiConnections.state, "active"),
              isNull(userAiConnections.disconnectedAt),
            ),
          )
          .for("update");
        if (!connection) throw new PersonalAiCredentialLeaseRefusedError();

        const [redeemed] = await transaction
          .update(personalAiCredentialLeases)
          .set({ redeemedAt: sql`now()` })
          .where(
            and(
              eq(personalAiCredentialLeases.id, lease.id),
              isNull(personalAiCredentialLeases.redeemedAt),
              sql`${personalAiCredentialLeases.expiresAt} > now()`,
            ),
          )
          .returning({ id: personalAiCredentialLeases.id });
        if (!redeemed) throw new PersonalAiCredentialLeaseRefusedError();

        const plaintext = await decryptSecret(
          input.encryptionKey,
          connection.encryptedValue,
        );
        return runtimeCredential(connection.provider, plaintext);
      });
    },
  });
}
