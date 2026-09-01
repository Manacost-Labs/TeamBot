import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  type CredentialStoreValue,
  createCredentialStore,
  encryptSecret,
} from "../credentials";
import type { Database } from "../db/client";
import { auditEvents, credentials, userAiConnections } from "../db/schema";

export type PersonalAiProvider = "chatgpt" | "openrouter";
export type PersonalAiConnectionState = "active" | "disconnected";

/**
 * The complete metadata contract that may leave the server.
 *
 * It deliberately excludes provider labels, key suffixes, account identifiers and arbitrary
 * provider response fields. Task 12's validator may populate only these account-limit values, and
 * this store filters them again before both persistence and projection.
 */
export type PersonalAiSafeMetadata = {
  usageUsd?: number;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  isFreeTier?: boolean;
};

export type PersonalAiConnectionStatus = {
  provider: PersonalAiProvider;
  state: PersonalAiConnectionState;
  validatedAt: Date;
  disconnectedAt: Date | null;
  updatedAt: Date;
  safeMetadata: PersonalAiSafeMetadata;
};

export type PersonalAiConnectionAuditEvent = {
  action: "connected" | "replaced" | "disconnected";
  actorUserId: string;
  provider: PersonalAiProvider;
  state: PersonalAiConnectionState;
};

export type PersonalAiConnectionAuditor = {
  record: (event: PersonalAiConnectionAuditEvent) => Promise<void>;
};

type StoreInput = {
  database: Database;
  encryptionKey: string;
  audit?: PersonalAiConnectionAuditor;
  now?: () => Date;
};

type ConnectInput = {
  actorUserId: string;
  provider: PersonalAiProvider;
  plaintext: string;
  safeMetadata: PersonalAiSafeMetadata;
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function isProvider(value: unknown): value is PersonalAiProvider {
  return value === "chatgpt" || value === "openrouter";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nullableFiniteNonNegative(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finiteNonNegative(value);
}

/** Runtime filtering is intentional: callers may be JavaScript or decoded JSON, not TypeScript. */
export function projectPersonalAiSafeMetadata(
  value: unknown,
): PersonalAiSafeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const source = value as Record<string, unknown>;
  const projected: PersonalAiSafeMetadata = {};
  const usageUsd = finiteNonNegative(source.usageUsd);
  const limitUsd = nullableFiniteNonNegative(source.limitUsd);
  const limitRemainingUsd = nullableFiniteNonNegative(source.limitRemainingUsd);
  if (usageUsd !== undefined) projected.usageUsd = usageUsd;
  if (limitUsd !== undefined) projected.limitUsd = limitUsd;
  if (limitRemainingUsd !== undefined) {
    projected.limitRemainingUsd = limitRemainingUsd;
  }
  if (typeof source.isFreeTier === "boolean") {
    projected.isFreeTier = source.isFreeTier;
  }

  return projected;
}

/** A stable vault address chosen by the server, never by an API payload. */
export function derivePersonalAiCredentialKeyId(
  actorUserId: string,
  provider: PersonalAiProvider,
) {
  const actorDigest = createHash("sha256")
    .update(actorUserId)
    .digest("base64url");
  return `personal-ai:${provider}:${actorDigest}`;
}

function connectionStatus(input: {
  provider: PersonalAiProvider;
  state: PersonalAiConnectionState;
  validatedAt: Date;
  disconnectedAt: Date | null;
  updatedAt: Date;
  metadata: unknown;
}): PersonalAiConnectionStatus {
  return {
    provider: input.provider,
    state: input.state,
    validatedAt: input.validatedAt,
    disconnectedAt: input.disconnectedAt,
    updatedAt: input.updatedAt,
    safeMetadata: projectPersonalAiSafeMetadata(input.metadata),
  };
}

async function lockActor(transaction: Transaction, actorUserId: string) {
  // There is no connection row to lock on a person's first connect. A transaction-scoped advisory
  // lock serialises that empty-row case too, preventing two first connects from leaving an orphan
  // live credential when they race to upsert the same user primary key.
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${actorUserId}, 0))`,
  );
}

function databaseAuditor(database: Database): PersonalAiConnectionAuditor {
  return {
    record: async (event) => {
      await database.insert(auditEvents).values({
        eventType: `personal_ai_connection.${event.action}`,
        targetType: "user_ai_connection",
        targetId: event.actorUserId,
        actorUserId: event.actorUserId,
        // The provider and state are the full permitted audit payload. In particular there is no
        // metadata, key id, credential id, ciphertext or plaintext on this path.
        payload: { provider: event.provider, state: event.state },
      });
    },
  };
}

/**
 * Persist one actor's personal model connection.
 *
 * Ownership is the authenticated actor argument itself. There is deliberately no target-user or
 * credential-id parameter on any operation. The credential pointer is discovered under a lock and
 * all vault and connection writes share one database transaction.
 */
export function createPersonalAiConnectionStore(input: StoreInput) {
  const credentialStore = createCredentialStore(input.database);
  const now = input.now ?? (() => new Date());
  const audit = input.audit ?? databaseAuditor(input.database);

  async function emit(event: PersonalAiConnectionAuditEvent) {
    // The connection is authoritative. Audit is written after commit so an audit-store outage cannot
    // roll back a valid provider connection or make a committed operation look failed to its caller.
    try {
      await audit.record(event);
    } catch {
      // Nothing from the rejected audit write is logged: even error objects from storage adapters can
      // contain query parameters. Operational audit health is monitored at its own boundary.
    }
  }

  async function status(
    actorUserId: string,
  ): Promise<PersonalAiConnectionStatus | null> {
    const [row] = await input.database
      .select({
        provider: userAiConnections.provider,
        state: userAiConnections.state,
        validatedAt: userAiConnections.validatedAt,
        disconnectedAt: userAiConnections.disconnectedAt,
        updatedAt: userAiConnections.updatedAt,
        metadata: credentials.metadata,
      })
      .from(userAiConnections)
      .innerJoin(
        credentials,
        eq(userAiConnections.credentialId, credentials.id),
      )
      .where(eq(userAiConnections.userId, actorUserId));

    return row ? connectionStatus(row) : null;
  }

  async function connect(
    connectInput: ConnectInput,
  ): Promise<PersonalAiConnectionStatus> {
    if (!connectInput.actorUserId || !isProvider(connectInput.provider)) {
      throw new Error("Personal AI connection input is invalid");
    }
    if (
      typeof connectInput.plaintext !== "string" ||
      connectInput.plaintext.length === 0
    ) {
      throw new Error("Personal AI credential is required");
    }

    const metadata = projectPersonalAiSafeMetadata(
      connectInput.safeMetadata,
    ) as Record<string, unknown>;
    const desired: Omit<CredentialStoreValue, "encryptedValue" | "metadata"> = {
      kind: "model",
      provider: connectInput.provider,
      keyId: derivePersonalAiCredentialKeyId(
        connectInput.actorUserId,
        connectInput.provider,
      ),
    };
    // Encryption is deliberately outside the transaction so a pooled connection is not held while
    // WebCrypto does work. Only the encrypted envelope crosses into the database callback.
    const encryptedValue = await encryptSecret(
      input.encryptionKey,
      connectInput.plaintext,
    );
    const timestamp = now();

    const result = await input.database.transaction(async (transaction) => {
      await lockActor(transaction, connectInput.actorUserId);

      const [existing] = await transaction
        .select({
          credentialId: userAiConnections.credentialId,
        })
        .from(userAiConnections)
        .where(eq(userAiConnections.userId, connectInput.actorUserId))
        .for("update");

      const [previous] = existing
        ? await transaction
            .select({
              id: credentials.id,
              kind: credentials.kind,
              provider: credentials.provider,
              keyId: credentials.keyId,
              revokedAt: credentials.revokedAt,
            })
            .from(credentials)
            .where(eq(credentials.id, existing.credentialId))
            .for("update")
        : [];

      const value: CredentialStoreValue = {
        ...desired,
        metadata,
        encryptedValue,
      };
      const previousMatchesDesired =
        previous?.revokedAt === null &&
        previous.kind === desired.kind &&
        previous.provider === desired.provider &&
        previous.keyId === desired.keyId;

      let stored: { id: string; revokedAt: Date | null };
      if (previousMatchesDesired && previous) {
        stored = await credentialStore.rotate(
          { ...value, previousCredentialId: previous.id },
          transaction,
        );
      } else {
        if (previous?.revokedAt === null) {
          // Provider switches cannot use `rotate`: the vault correctly requires the old and new key
          // identity to match. Revoke plus create is still atomic here because both receive this
          // transaction, along with the pointer update below.
          await credentialStore.revoke(previous.id, transaction);
        }

        const liveDesired = await credentialStore.findLiveByKey(
          desired,
          transaction,
        );
        stored = liveDesired
          ? await credentialStore.rotate(
              { ...value, previousCredentialId: liveDesired.id },
              transaction,
            )
          : await credentialStore.create(value, transaction);
      }

      const write = {
        provider: connectInput.provider,
        credentialId: stored.id,
        state: "active" as const,
        validatedAt: timestamp,
        disconnectedAt: null,
        updatedAt: timestamp,
      };
      const [connection] = existing
        ? await transaction
            .update(userAiConnections)
            .set(write)
            .where(eq(userAiConnections.userId, connectInput.actorUserId))
            .returning({
              provider: userAiConnections.provider,
              state: userAiConnections.state,
              validatedAt: userAiConnections.validatedAt,
              disconnectedAt: userAiConnections.disconnectedAt,
              updatedAt: userAiConnections.updatedAt,
            })
        : await transaction
            .insert(userAiConnections)
            .values({ userId: connectInput.actorUserId, ...write })
            .returning({
              provider: userAiConnections.provider,
              state: userAiConnections.state,
              validatedAt: userAiConnections.validatedAt,
              disconnectedAt: userAiConnections.disconnectedAt,
              updatedAt: userAiConnections.updatedAt,
            });
      if (!connection) {
        throw new Error("Personal AI connection could not be stored");
      }

      return {
        status: connectionStatus({ ...connection, metadata }),
        action: existing ? ("replaced" as const) : ("connected" as const),
      };
    });

    await emit({
      action: result.action,
      actorUserId: connectInput.actorUserId,
      provider: result.status.provider,
      state: result.status.state,
    });
    return result.status;
  }

  async function disconnect(
    actorUserId: string,
  ): Promise<PersonalAiConnectionStatus | null> {
    if (!actorUserId) throw new Error("Personal AI actor is required");

    const result = await input.database.transaction(async (transaction) => {
      await lockActor(transaction, actorUserId);
      const [connection] = await transaction
        .select({
          credentialId: userAiConnections.credentialId,
          provider: userAiConnections.provider,
          state: userAiConnections.state,
          validatedAt: userAiConnections.validatedAt,
          disconnectedAt: userAiConnections.disconnectedAt,
          updatedAt: userAiConnections.updatedAt,
        })
        .from(userAiConnections)
        .where(eq(userAiConnections.userId, actorUserId))
        .for("update");
      if (!connection) return { status: null, changed: false };

      const [credential] = await transaction
        .select({
          id: credentials.id,
          metadata: credentials.metadata,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, connection.credentialId))
        .for("update");
      if (!credential) {
        throw new Error("Personal AI credential was not found");
      }

      if (connection.state === "disconnected") {
        return {
          status: connectionStatus({
            ...connection,
            metadata: credential.metadata,
          }),
          changed: false,
        };
      }

      if (credential.revokedAt === null) {
        await credentialStore.revoke(credential.id, transaction);
      }
      const timestamp = now();
      const [disconnected] = await transaction
        .update(userAiConnections)
        .set({
          state: "disconnected",
          disconnectedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(userAiConnections.userId, actorUserId))
        .returning({
          provider: userAiConnections.provider,
          state: userAiConnections.state,
          validatedAt: userAiConnections.validatedAt,
          disconnectedAt: userAiConnections.disconnectedAt,
          updatedAt: userAiConnections.updatedAt,
        });
      if (!disconnected) {
        throw new Error("Personal AI connection could not be disconnected");
      }
      return {
        status: connectionStatus({
          ...disconnected,
          metadata: credential.metadata,
        }),
        changed: true,
      };
    });

    if (result.changed && result.status) {
      await emit({
        action: "disconnected",
        actorUserId,
        provider: result.status.provider,
        state: result.status.state,
      });
    }
    return result.status;
  }

  return { connect, status, disconnect };
}
