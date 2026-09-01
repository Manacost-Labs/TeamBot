import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TELEGRAM_LOGIN_FIELDS = new Set([
  "id",
  "first_name",
  "last_name",
  "username",
  "photo_url",
  "auth_date",
  "hash",
]);
const REQUIRED_TELEGRAM_LOGIN_FIELDS = [
  "id",
  "first_name",
  "auth_date",
  "hash",
] as const;
const MAX_TELEGRAM_ID = (1n << 52n) - 1n;
const MAX_AUTH_AGE_SECONDS = 300;
const HASH_HEX_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const DEFAULT_STATE_TTL_MILLISECONDS = 120_000;
const MAX_STATE_TTL_MILLISECONDS = 300_000;
const DEFAULT_ALLOWED_RETURN_PATHS = ["/", "/settings"] as const;

export class TelegramLoginError extends Error {
  readonly code = "INVALID_TELEGRAM_LOGIN" as const;

  constructor() {
    super("Telegram login failed.");
    this.name = "TelegramLoginError";
  }
}

export type VerifiedTelegramLogin = Readonly<{
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  authDate: number;
  replayKey: string;
}>;

export type VerifyTelegramLoginOptions = Readonly<{
  botToken: string;
  nowSeconds?: number;
}>;

function rejectLogin(): never {
  throw new TelegramLoginError();
}

function isBoundedText(value: string, maximumLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximumLength &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

function parseStrictFields(
  input: Iterable<readonly [string, string]>,
): Map<string, string> {
  const fields = new Map<string, string>();
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      rejectLogin();
    }
    const [name, value] = entry;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !TELEGRAM_LOGIN_FIELDS.has(name) ||
      fields.has(name)
    ) {
      rejectLogin();
    }
    fields.set(name, value);
  }

  for (const requiredField of REQUIRED_TELEGRAM_LOGIN_FIELDS) {
    if (!fields.has(requiredField)) {
      rejectLogin();
    }
  }
  return fields;
}

function parseTelegramId(value: string): string {
  if (!CANONICAL_POSITIVE_INTEGER_PATTERN.test(value) || value.length > 16) {
    rejectLogin();
  }
  try {
    if (BigInt(value) > MAX_TELEGRAM_ID) {
      rejectLogin();
    }
  } catch {
    rejectLogin();
  }
  return value;
}

function parseAuthDate(value: string): number {
  if (!CANONICAL_POSITIVE_INTEGER_PATTERN.test(value) || value.length > 16) {
    rejectLogin();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    rejectLogin();
  }
  return parsed;
}

function validateProfileFields(fields: ReadonlyMap<string, string>): void {
  const firstName = fields.get("first_name");
  if (!firstName || !isBoundedText(firstName, 256)) {
    rejectLogin();
  }

  const lastName = fields.get("last_name");
  if (lastName !== undefined && !isBoundedText(lastName, 256)) {
    rejectLogin();
  }

  const username = fields.get("username");
  if (username !== undefined && !USERNAME_PATTERN.test(username)) {
    rejectLogin();
  }

  const photoUrl = fields.get("photo_url");
  if (photoUrl !== undefined) {
    if (photoUrl.length === 0 || photoUrl.length > 2_048) {
      rejectLogin();
    }
    try {
      const parsed = new URL(photoUrl);
      if (
        parsed.protocol !== "https:" ||
        parsed.username !== "" ||
        parsed.password !== ""
      ) {
        rejectLogin();
      }
    } catch {
      rejectLogin();
    }
  }
}

function createDataCheckString(fields: ReadonlyMap<string, string>): string {
  return [...fields.entries()]
    .filter(([name]) => name !== "hash")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

/**
 * Compare Telegram's hexadecimal signature without ever passing differently sized buffers to
 * `timingSafeEqual`. Malformed candidates still execute one 32-byte constant-time comparison and
 * are rejected afterwards.
 */
function telegramHashMatches(candidate: string, expected: Buffer): boolean {
  const isCanonical = HASH_HEX_PATTERN.test(candidate);
  const candidateBytes = isCanonical
    ? Buffer.from(candidate, "hex")
    : Buffer.alloc(32);
  const matches = timingSafeEqual(candidateBytes, expected);
  return isCanonical && matches;
}

/**
 * Verify the strict, documented legacy Telegram Login Widget payload.
 *
 * All externally observable failures use the same error. The returned object deliberately omits
 * the signature so downstream session and audit code cannot accidentally expose it.
 */
export function verifyTelegramLoginPayload(
  input: Iterable<readonly [string, string]>,
  options: VerifyTelegramLoginOptions,
): VerifiedTelegramLogin {
  try {
    const fields = parseStrictFields(input);
    const id = parseTelegramId(fields.get("id") ?? "");
    validateProfileFields(fields);
    const authDate = parseAuthDate(fields.get("auth_date") ?? "");
    const candidateHash = fields.get("hash") ?? "";

    if (!isBoundedText(options.botToken, 4_096)) {
      rejectLogin();
    }
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
      rejectLogin();
    }

    const secretKey = createHash("sha256").update(options.botToken).digest();
    const expectedHash = createHmac("sha256", secretKey)
      .update(createDataCheckString(fields))
      .digest();
    if (!telegramHashMatches(candidateHash, expectedHash)) {
      rejectLogin();
    }

    const ageSeconds = nowSeconds - authDate;
    if (ageSeconds < 0 || ageSeconds > MAX_AUTH_AGE_SECONDS) {
      rejectLogin();
    }

    return Object.freeze({
      id,
      firstName: fields.get("first_name") ?? "",
      ...(fields.has("last_name") ? { lastName: fields.get("last_name") } : {}),
      ...(fields.has("username") ? { username: fields.get("username") } : {}),
      ...(fields.has("photo_url") ? { photoUrl: fields.get("photo_url") } : {}),
      authDate,
      replayKey: createHash("sha256").update(candidateHash).digest("hex"),
    });
  } catch (error) {
    if (error instanceof TelegramLoginError) {
      throw error;
    }
    rejectLogin();
  }
}

export type TelegramLoginStateStorageRecord = Readonly<{
  stateDigest: string;
  trustedOrigin: string;
  returnPath: string;
  browserBindingDigest: string;
  expiresAt: number;
}>;

/**
 * Production implementations must make each method atomic in shared storage. The in-memory
 * implementation below is a reference/test adapter; Task 6 can bind this interface to Better
 * Auth's database-backed verification primitives without changing the cryptographic boundary.
 */
export interface TelegramLoginOneTimeStorage {
  createState(
    record: TelegramLoginStateStorageRecord,
    nowMilliseconds: number,
  ): Promise<boolean>;
  consumeState(
    stateDigest: string,
  ): Promise<TelegramLoginStateStorageRecord | null>;
  reserveProof(
    replayKey: string,
    expiresAt: number,
    nowMilliseconds: number,
  ): Promise<boolean>;
}

export class InMemoryTelegramLoginOneTimeStorage
  implements TelegramLoginOneTimeStorage
{
  readonly #states = new Map<string, TelegramLoginStateStorageRecord>();
  readonly #proofReservations = new Map<string, number>();

  async createState(
    record: TelegramLoginStateStorageRecord,
    nowMilliseconds: number,
  ): Promise<boolean> {
    for (const [digest, existing] of this.#states) {
      if (nowMilliseconds >= existing.expiresAt) {
        this.#states.delete(digest);
      }
    }
    if (this.#states.has(record.stateDigest)) {
      return false;
    }
    this.#states.set(record.stateDigest, record);
    return true;
  }

  async consumeState(
    stateDigest: string,
  ): Promise<TelegramLoginStateStorageRecord | null> {
    const record = this.#states.get(stateDigest) ?? null;
    if (record) {
      // No await occurs between lookup and delete, so only one caller can receive the record.
      this.#states.delete(stateDigest);
    }
    return record;
  }

  async reserveProof(
    replayKey: string,
    expiresAt: number,
    nowMilliseconds: number,
  ): Promise<boolean> {
    for (const [key, existingExpiresAt] of this.#proofReservations) {
      if (nowMilliseconds >= existingExpiresAt) {
        this.#proofReservations.delete(key);
      }
    }
    if (this.#proofReservations.has(replayKey)) {
      return false;
    }
    this.#proofReservations.set(replayKey, expiresAt);
    return true;
  }
}

export type TelegramLoginStateStoreOptions = Readonly<{
  trustedOrigin: string;
  allowedReturnPaths?: readonly string[];
  ttlMilliseconds?: number;
  now?: () => number;
  storage?: TelegramLoginOneTimeStorage;
}>;

export type IssueTelegramLoginStateInput = Readonly<{
  requestOrigin: string;
  returnPath: string;
}>;

export type IssuedTelegramLoginState = Readonly<{
  state: string;
  browserBinding: string;
}>;

export type ConsumeTelegramLoginStateInput = Readonly<{
  state: string;
  requestOrigin: string;
  browserBinding: string;
}>;

function isSafeLocalPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !path.includes("%") &&
    !path.includes("?") &&
    !path.includes("#")
  );
}

function digestSecret(label: string, secret: string): Buffer {
  return createHash("sha256")
    .update(label)
    .update("\0")
    .update(secret)
    .digest();
}

function digestKey(label: string, secret: string): string {
  return digestSecret(label, secret).toString("hex");
}

function isValidBrowserBinding(value: string): boolean {
  return HASH_HEX_PATTERN.test(value);
}

/**
 * One-time Telegram login state over an atomic storage adapter.
 *
 * Only digests of the state and browser binding are retained. Production supplies shared,
 * database-backed storage, so two replicas cannot both consume the same state. Consumption happens
 * before binding validation, so a failed stolen-state attempt cannot later be replayed with corrected
 * parameters.
 */
export class TelegramLoginStateStore {
  readonly #trustedOrigin: string;
  readonly #allowedReturnPaths: ReadonlySet<string>;
  readonly #ttlMilliseconds: number;
  readonly #now: () => number;
  readonly #storage: TelegramLoginOneTimeStorage;

  constructor(options: TelegramLoginStateStoreOptions) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(options.trustedOrigin);
    } catch {
      throw new Error("trustedOrigin must be a canonical HTTPS origin");
    }
    if (
      parsedOrigin.protocol !== "https:" ||
      parsedOrigin.origin !== options.trustedOrigin ||
      parsedOrigin.href !== `${options.trustedOrigin}/`
    ) {
      throw new Error("trustedOrigin must be a canonical HTTPS origin");
    }

    const allowedReturnPaths =
      options.allowedReturnPaths ?? DEFAULT_ALLOWED_RETURN_PATHS;
    if (
      allowedReturnPaths.length === 0 ||
      allowedReturnPaths.some((path) => !isSafeLocalPath(path))
    ) {
      throw new Error("allowedReturnPaths must contain safe local paths");
    }

    const ttlMilliseconds =
      options.ttlMilliseconds ?? DEFAULT_STATE_TTL_MILLISECONDS;
    if (
      !Number.isSafeInteger(ttlMilliseconds) ||
      ttlMilliseconds <= 0 ||
      ttlMilliseconds > MAX_STATE_TTL_MILLISECONDS
    ) {
      throw new Error("ttlMilliseconds must be between 1 and 300000");
    }

    this.#trustedOrigin = options.trustedOrigin;
    this.#allowedReturnPaths = new Set(allowedReturnPaths);
    this.#ttlMilliseconds = ttlMilliseconds;
    this.#now = options.now ?? Date.now;
    this.#storage =
      options.storage ?? new InMemoryTelegramLoginOneTimeStorage();
  }

  async issue(
    input: IssueTelegramLoginStateInput,
  ): Promise<IssuedTelegramLoginState> {
    try {
      if (
        input.requestOrigin !== this.#trustedOrigin ||
        !this.#allowedReturnPaths.has(input.returnPath)
      ) {
        rejectLogin();
      }

      const now = this.#readNow();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const state = randomBytes(32).toString("hex");
        const browserBinding = randomBytes(32).toString("hex");
        const record: TelegramLoginStateStorageRecord = Object.freeze({
          stateDigest: digestKey("telegram-login-state", state),
          trustedOrigin: this.#trustedOrigin,
          returnPath: input.returnPath,
          browserBindingDigest: digestKey(
            "telegram-browser-binding",
            browserBinding,
          ),
          expiresAt: now + this.#ttlMilliseconds,
        });
        if (await this.#storage.createState(record, now)) {
          return Object.freeze({ state, browserBinding });
        }
      }
      rejectLogin();
    } catch (error) {
      if (error instanceof TelegramLoginError) {
        throw error;
      }
      rejectLogin();
    }
  }

  async consume(input: ConsumeTelegramLoginStateInput): Promise<string> {
    try {
      if (!HASH_HEX_PATTERN.test(input.state)) {
        rejectLogin();
      }
      const stateDigest = digestKey("telegram-login-state", input.state);
      const record = await this.#storage.consumeState(stateDigest);
      if (!record) {
        rejectLogin();
      }

      const now = this.#readNow();
      const browserBindingIsValid = isValidBrowserBinding(input.browserBinding);
      const storedBindingIsValid = HASH_HEX_PATTERN.test(
        record.browserBindingDigest,
      );
      const suppliedBrowserBinding = browserBindingIsValid
        ? digestSecret("telegram-browser-binding", input.browserBinding)
        : Buffer.alloc(32);
      const storedBrowserBinding = storedBindingIsValid
        ? Buffer.from(record.browserBindingDigest, "hex")
        : Buffer.alloc(32);
      const browserMatches = timingSafeEqual(
        suppliedBrowserBinding,
        storedBrowserBinding,
      );
      if (
        record.stateDigest !== stateDigest ||
        now >= record.expiresAt ||
        input.requestOrigin !== record.trustedOrigin ||
        !this.#allowedReturnPaths.has(record.returnPath) ||
        !browserBindingIsValid ||
        !storedBindingIsValid ||
        !browserMatches
      ) {
        rejectLogin();
      }
      return record.returnPath;
    } catch (error) {
      if (error instanceof TelegramLoginError) {
        throw error;
      }
      rejectLogin();
    }
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now <= 0) {
      rejectLogin();
    }
    return now;
  }
}

export type TelegramLoginProofReplayStoreOptions = Readonly<{
  ttlMilliseconds?: number;
  now?: () => number;
  storage?: TelegramLoginOneTimeStorage;
}>;

/**
 * Atomically reserve the opaque replay key derived from a verified Telegram signature.
 *
 * This closes the gap where the same still-fresh signed proof is presented with a newly issued
 * browser state. The store never receives or retains the raw signed payload or Telegram hash.
 */
export class TelegramLoginProofReplayStore {
  readonly #ttlMilliseconds: number;
  readonly #now: () => number;
  readonly #storage: TelegramLoginOneTimeStorage;

  constructor(options: TelegramLoginProofReplayStoreOptions = {}) {
    const ttlMilliseconds =
      options.ttlMilliseconds ?? MAX_STATE_TTL_MILLISECONDS;
    if (
      !Number.isSafeInteger(ttlMilliseconds) ||
      ttlMilliseconds <= 0 ||
      ttlMilliseconds > MAX_STATE_TTL_MILLISECONDS
    ) {
      throw new Error("ttlMilliseconds must be between 1 and 300000");
    }
    this.#ttlMilliseconds = ttlMilliseconds;
    this.#now = options.now ?? Date.now;
    this.#storage =
      options.storage ?? new InMemoryTelegramLoginOneTimeStorage();
  }

  async reserve(replayKey: string): Promise<void> {
    try {
      if (!HASH_HEX_PATTERN.test(replayKey)) {
        rejectLogin();
      }
      const now = this.#readNow();
      const reserved = await this.#storage.reserveProof(
        replayKey,
        now + this.#ttlMilliseconds,
        now,
      );
      if (!reserved) {
        rejectLogin();
      }
    } catch (error) {
      if (error instanceof TelegramLoginError) {
        throw error;
      }
      rejectLogin();
    }
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now <= 0) {
      rejectLogin();
    }
    return now;
  }
}
