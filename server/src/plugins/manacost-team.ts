import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { and, asc, eq, gt, type InferSelectModel, isNull } from "drizzle-orm";
import { sign, verify } from "../auth/signed-value";
import type { Database } from "../db/client";
import {
  manacostAutonomyApprovals,
  manacostAutonomyCheckpoints,
  manacostAutonomyProfiles,
  manacostAutonomyRuns,
  pluginGrants,
  skills,
  skillTools,
} from "../db/schema";

export const MANACOST_AUTONOMY_PROFILE_ID = "default";
export const MANACOST_APPROVAL_LABEL = "manacost-team-approval-v1";
export const MANACOST_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_RUN_INPUT_CHARS = 16_384;
const MAX_RUN_INPUT_DEPTH = 5;
const MAX_RUN_INPUT_KEYS = 128;
const CANONICAL_SKILL_ID =
  /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})*$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AUTOMATIC_PARSER_ACTIONS = [
  "audit",
  "diagnose",
  "retry",
  "codegraph",
  "validate",
] as const;
export const APPROVAL_PARSER_ACTIONS = ["publish", "deploy"] as const;
export const PARSER_ACTIONS = [
  ...AUTOMATIC_PARSER_ACTIONS,
  ...APPROVAL_PARSER_ACTIONS,
] as const;

export type ParserAction = (typeof PARSER_ACTIONS)[number];
export type AutomaticParserAction = (typeof AUTOMATIC_PARSER_ACTIONS)[number];
export type ApprovalParserAction = (typeof APPROVAL_PARSER_ACTIONS)[number];
export type AutonomyStatus =
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "completed"
  | "failed";

export type AutonomyProfile = {
  id: string;
  maxSteps: number;
  maxDurationMs: number;
  maxRetries: number;
  maxOutputChars: number;
  automaticActions: readonly AutomaticParserAction[];
  approvalActions: readonly ApprovalParserAction[];
};

export const DEFAULT_AUTONOMY_PROFILE: AutonomyProfile = Object.freeze({
  id: MANACOST_AUTONOMY_PROFILE_ID,
  maxSteps: 12,
  maxDurationMs: 20 * 60 * 1000,
  maxRetries: 2,
  maxOutputChars: 20_000,
  automaticActions: AUTOMATIC_PARSER_ACTIONS,
  approvalActions: APPROVAL_PARSER_ACTIONS,
});

export type CanonicalSkillManifestEntry = {
  /** Canonical inventory calls this field `id`; `slug` remains accepted for compatibility. */
  id?: string;
  slug?: string;
  title: string;
  summary: string;
  /** Relative to the allowlisted canonical root. */
  path: string;
  sha256: string;
  tools?: string[];
  companions?: Array<{ path: string; sha256: string }>;
};

export type CanonicalSkillManifest = {
  schemaVersion: 1;
  repo: string;
  commit: string;
  skills: CanonicalSkillManifestEntry[];
};

/** The only filesystem roots the importer is allowed to inspect. */
export type CanonicalSkillRoot = {
  id: string;
  root: string;
  repo: string;
  commit: string;
  /** SHA-256 of the exact manifest.json bytes. */
  manifestSha256: string;
};

export type LoadedCanonicalSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools: string[];
  companionFiles: Array<{
    path: string;
    sha256: string;
    content: string;
  }>;
  sourceRoot: string;
  sourceRepo: string;
  sourceCommit: string;
  manifestHash: string;
  provenance: {
    kind: "canonical";
    rootId: string;
    repo: string;
    commit: string;
    manifestSha256: string;
    entryPath: string;
    companionPaths: string[];
  };
};

export class ManacostTeamRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManacostTeamRefusedError";
  }
}

class AutonomyBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutonomyBoundError";
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isHex(value: unknown, length: number): value is string {
  return (
    typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  );
}

function isCommit(value: unknown): value is string {
  return (
    typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  );
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManacostTeamRefusedError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManacostTeamRefusedError(`${name} must be a non-empty string.`);
  }
  return value;
}

function safeRelativePath(
  root: string,
  candidate: unknown,
  name: string,
): string {
  const path = nonEmptyString(candidate, name);
  if (
    isAbsolute(path) ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "..")
  ) {
    throw new ManacostTeamRefusedError(
      `${name} must be relative to the canonical root.`,
    );
  }
  const resolved = resolve(root, path);
  const rest = relative(root, resolved);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new ManacostTeamRefusedError(`${name} escapes the canonical root.`);
  }
  return path;
}

async function readCanonicalFile(
  root: string,
  path: string,
  expectedHash: string,
  name: string,
): Promise<{ content: string; hash: string }> {
  const file = resolve(root, path);
  const actual = await realpath(file).catch(() => {
    throw new ManacostTeamRefusedError(`${name} does not exist.`);
  });
  const rest = relative(root, actual);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new ManacostTeamRefusedError(
      `${name} resolves outside the canonical root.`,
    );
  }
  const bytes = await readFile(actual).catch(() => {
    throw new ManacostTeamRefusedError(`${name} could not be read.`);
  });
  const hash = sha256(bytes);
  if (hash !== expectedHash) {
    throw new ManacostTeamRefusedError(
      `${name} hash does not match its manifest.`,
    );
  }
  if (bytes.byteLength > 512 * 1024) {
    throw new ManacostTeamRefusedError(
      `${name} is larger than the skill file limit.`,
    );
  }
  return { content: Buffer.from(bytes).toString("utf8"), hash };
}

/**
 * Validate and load one pinned canonical root. The caller supplies the allowlist entry; no request
 * body can choose a root, repository, commit, manifest, or companion file.
 */
export async function loadCanonicalSkillRoot(
  configured: CanonicalSkillRoot,
): Promise<LoadedCanonicalSkill[]> {
  const root = await realpath(configured.root).catch(() => {
    throw new ManacostTeamRefusedError(
      `Canonical skill root "${configured.id}" is unavailable.`,
    );
  });
  if (!isAbsolute(root)) {
    throw new ManacostTeamRefusedError(
      "A canonical skill root must be absolute.",
    );
  }
  if (!configured.repo.trim() || !isCommit(configured.commit)) {
    throw new ManacostTeamRefusedError(
      `Canonical root "${configured.id}" is not pinned to a full commit.`,
    );
  }
  if (!isHex(configured.manifestSha256, 64)) {
    throw new ManacostTeamRefusedError(
      `Canonical root "${configured.id}" has no valid manifest hash.`,
    );
  }

  const manifestFile = await readCanonicalFile(
    root,
    "manifest.json",
    configured.manifestSha256,
    `Canonical root "${configured.id}" manifest`,
  );
  const manifestHash = manifestFile.hash;

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestFile.content);
  } catch {
    throw new ManacostTeamRefusedError(
      "The canonical skill manifest is invalid JSON.",
    );
  }
  const manifest = record(parsed, "Canonical skill manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repo !== configured.repo ||
    manifest.commit !== configured.commit ||
    !Array.isArray(manifest.skills) ||
    manifest.skills.length > 500
  ) {
    throw new ManacostTeamRefusedError(
      `Canonical root "${configured.id}" manifest identity or shape is invalid.`,
    );
  }

  const seenSlugs = new Set<string>();
  const loaded: LoadedCanonicalSkill[] = [];
  for (const [index, item] of manifest.skills.entries()) {
    const entry = record(item, `Canonical skill ${index}`);
    const slug = nonEmptyString(
      entry.slug ?? entry.id,
      `Canonical skill ${index}.id`,
    );
    if (!CANONICAL_SKILL_ID.test(slug) || seenSlugs.has(slug)) {
      throw new ManacostTeamRefusedError(
        `Canonical skill slug "${slug}" is invalid or duplicated.`,
      );
    }
    seenSlugs.add(slug);
    const path = safeRelativePath(
      root,
      entry.path,
      `Canonical skill ${slug}.path`,
    );
    const expectedHash = entry.sha256;
    if (!isHex(expectedHash, 64)) {
      throw new ManacostTeamRefusedError(
        `Canonical skill "${slug}" has an invalid file hash.`,
      );
    }
    const instructions = await readCanonicalFile(
      root,
      path,
      expectedHash,
      `Canonical skill "${slug}"`,
    );
    const rawTools = entry.tools === undefined ? [] : entry.tools;
    if (
      !Array.isArray(rawTools) ||
      rawTools.some(
        (tool) => typeof tool !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(tool),
      )
    ) {
      throw new ManacostTeamRefusedError(
        `Canonical skill "${slug}" has an invalid tool declaration.`,
      );
    }
    const companions = entry.companions === undefined ? [] : entry.companions;
    if (!Array.isArray(companions) || companions.length > 32) {
      throw new ManacostTeamRefusedError(
        `Canonical skill "${slug}" has too many companion files.`,
      );
    }
    const companionFiles: LoadedCanonicalSkill["companionFiles"] = [];
    const companionPaths = new Set<string>();
    for (const [companionIndex, value] of companions.entries()) {
      const companion = record(
        value,
        `Canonical skill "${slug}" companion ${companionIndex}`,
      );
      const companionPath = safeRelativePath(
        root,
        companion.path,
        `Canonical skill "${slug}" companion path`,
      );
      if (companionPaths.has(companionPath) || companionPath === path) {
        throw new ManacostTeamRefusedError(
          `Canonical skill "${slug}" has a duplicate companion file.`,
        );
      }
      companionPaths.add(companionPath);
      if (!isHex(companion.sha256, 64)) {
        throw new ManacostTeamRefusedError(
          `Canonical skill "${slug}" has an invalid companion hash.`,
        );
      }
      const content = await readCanonicalFile(
        root,
        companionPath,
        companion.sha256,
        `Canonical skill "${slug}" companion "${companionPath}"`,
      );
      companionFiles.push({
        path: companionPath,
        sha256: content.hash,
        content: content.content,
      });
    }

    loaded.push({
      slug,
      title: nonEmptyString(entry.title, `Canonical skill "${slug}" title`),
      summary: nonEmptyString(
        entry.summary,
        `Canonical skill "${slug}" summary`,
      ),
      instructions: instructions.content,
      tools: [...new Set(rawTools as string[])],
      companionFiles,
      sourceRoot: root,
      sourceRepo: configured.repo,
      sourceCommit: configured.commit,
      manifestHash,
      provenance: {
        kind: "canonical",
        rootId: configured.id,
        repo: configured.repo,
        commit: configured.commit,
        manifestSha256: manifestHash,
        entryPath: path,
        companionPaths: [...companionPaths],
      },
    });
  }
  return loaded;
}

/** Parse only server configuration; malformed configured manifests fail closed. */
export function canonicalRootsFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): CanonicalSkillRoot[] {
  const value = environment.MANACOST_CANONICAL_SKILL_MANIFESTS?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ManacostTeamRefusedError(
      "MANACOST_CANONICAL_SKILL_MANIFESTS must be valid JSON.",
    );
  }
  if (!Array.isArray(parsed) || parsed.length > 32) {
    throw new ManacostTeamRefusedError(
      "MANACOST_CANONICAL_SKILL_MANIFESTS must be an array of at most 32 roots.",
    );
  }
  return parsed.map((item, index) => {
    const root = record(item, `Canonical root ${index}`);
    return {
      id: nonEmptyString(
        root.id ?? `root-${index}`,
        `Canonical root ${index}.id`,
      ),
      root: nonEmptyString(root.root, `Canonical root ${index}.root`),
      repo: nonEmptyString(root.repo, `Canonical root ${index}.repo`),
      commit: nonEmptyString(root.commit, `Canonical root ${index}.commit`),
      manifestSha256: nonEmptyString(
        root.manifestSha256,
        `Canonical root ${index}.manifestSha256`,
      ),
    };
  });
}

export function filterDeclaredTools(
  declared: readonly string[],
  granted: ReadonlySet<string>,
): string[] {
  return [...new Set(declared.filter((ref) => granted.has(ref)))];
}

type ApprovalPayload = {
  runId: string;
  action: ApprovalParserAction;
  nonce: string;
  exp: number;
};

export function mintManacostApproval(
  input: Pick<ApprovalPayload, "runId" | "action">,
  encryptionKey: string,
  now = Date.now(),
  ttlMs = MANACOST_APPROVAL_TTL_MS,
) {
  if (
    !UUID.test(input.runId) ||
    !APPROVAL_PARSER_ACTIONS.includes(input.action)
  ) {
    throw new ManacostTeamRefusedError(
      "An approval requires one publish or deploy action.",
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new ManacostTeamRefusedError("Approval lifetime must be positive.");
  }
  const payload: ApprovalPayload = {
    runId: input.runId,
    action: input.action,
    nonce: randomUUID(),
    exp: now + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = sign(encoded, encryptionKey, MANACOST_APPROVAL_LABEL);
  return { token, tokenHash: sha256(token), expiresAt: new Date(payload.exp) };
}

export function readManacostApproval(
  token: unknown,
  encryptionKey: string,
  now = Date.now(),
): ApprovalPayload | null {
  if (typeof token !== "string") return null;
  const value = verify(token, encryptionKey, MANACOST_APPROVAL_LABEL);
  if (!value) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ApprovalPayload>;
    if (
      typeof payload.runId !== "string" ||
      !UUID.test(payload.runId) ||
      !APPROVAL_PARSER_ACTIONS.includes(
        payload.action as ApprovalParserAction,
      ) ||
      typeof payload.nonce !== "string" ||
      !payload.nonce ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= now
    ) {
      return null;
    }
    return payload as ApprovalPayload;
  } catch {
    return null;
  }
}

export type ParserActionExecution = (input: {
  action: ParserAction;
  runId: string;
  actorId: string;
  botId: string;
  input: Record<string, unknown>;
}) => Promise<unknown>;

export type ManacostTeamServiceOptions = {
  database: Database;
  encryptionKey: string;
  canonicalRoots?: readonly CanonicalSkillRoot[];
  executeParserAction?: ParserActionExecution;
};

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable result]";
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /(authorization|api[_-]?key|secret|token|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);
}

function validateRunInput(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManacostTeamRefusedError("Run input must be an object.");
  }
  if (depth > MAX_RUN_INPUT_DEPTH) {
    throw new ManacostTeamRefusedError("Run input is nested too deeply.");
  }
  const object = value as Record<string, unknown>;
  if (seen.has(object)) {
    throw new ManacostTeamRefusedError("Run input cannot contain cycles.");
  }
  seen.add(object);
  const entries = Object.entries(object);
  if (entries.length > MAX_RUN_INPUT_KEYS) {
    throw new ManacostTeamRefusedError("Run input contains too many fields.");
  }
  const sensitive =
    /(authorization|api[_-]?key|credential|password|private[_-]?key|secret|token)/i;
  for (const [key, item] of entries) {
    if (sensitive.test(key)) {
      throw new ManacostTeamRefusedError(
        `Run input field "${key}" cannot contain credentials.`,
      );
    }
    if (typeof item === "string" && item.length > 4096) {
      throw new ManacostTeamRefusedError(
        `Run input field "${key}" is too long.`,
      );
    }
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        if (item.length > MAX_RUN_INPUT_KEYS) {
          throw new ManacostTeamRefusedError(
            `Run input field "${key}" contains too many items.`,
          );
        }
        for (const child of item) {
          if (child && typeof child === "object")
            validateRunInput(child, depth + 1, seen);
        }
      } else {
        validateRunInput(item, depth + 1, seen);
      }
    }
  }
  return object;
}

function validNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ManacostTeamRefusedError(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function actionSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T[] {
  // A malformed persisted policy must fail closed. Defaults are applied by the INSERT, not by
  // interpreting an arbitrary value as "all actions" during a run.
  if (!Array.isArray(value)) return [];
  return allowed.filter((action) => value.includes(action));
}

function canonicalSkillSlug(value: string, name = "skillSlug"): string {
  if (value.length > 255 || !CANONICAL_SKILL_ID.test(value)) {
    throw new ManacostTeamRefusedError(
      `${name} must be a namespaced canonical skill id of at most 255 characters.`,
    );
  }
  return value;
}

function publicProvenance(
  row: Pick<
    InferSelectModel<typeof skills>,
    "sourceRepo" | "sourceCommit" | "manifestHash" | "provenance"
  >,
) {
  const stored =
    row.provenance &&
    typeof row.provenance === "object" &&
    !Array.isArray(row.provenance)
      ? (row.provenance as Record<string, unknown>)
      : {};
  const rootId = typeof stored.rootId === "string" ? stored.rootId : null;
  const entryPath =
    typeof stored.entryPath === "string" ? stored.entryPath : null;
  const companionPaths = Array.isArray(stored.companionPaths)
    ? stored.companionPaths.filter(
        (path): path is string => typeof path === "string",
      )
    : [];
  return {
    kind: "canonical" as const,
    rootId,
    repo: row.sourceRepo,
    commit: row.sourceCommit?.trim() || null,
    manifestHash: row.manifestHash?.trim() || null,
    entryPath,
    companionPaths,
  };
}

function profileFromRow(
  row: InferSelectModel<typeof manacostAutonomyProfiles>,
): AutonomyProfile {
  return {
    id: row.id,
    maxSteps: row.maxSteps,
    maxDurationMs: row.maxDurationMs,
    maxRetries: row.maxRetries,
    maxOutputChars: row.maxOutputChars,
    automaticActions: actionSet(row.automaticActions, AUTOMATIC_PARSER_ACTIONS),
    approvalActions: actionSet(row.approvalActions, APPROVAL_PARSER_ACTIONS),
  };
}

function publicRun(row: InferSelectModel<typeof manacostAutonomyRuns>) {
  return {
    id: row.id,
    actorId: row.actorId,
    botId: row.botId,
    skillSlug: row.skillSlug,
    action: row.action as ParserAction,
    status: row.status as AutonomyStatus,
    step: row.step,
    retries: row.retries,
    outputChars: row.outputChars,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    lastError: row.lastError,
  };
}

function publicCheckpoint(
  row: InferSelectModel<typeof manacostAutonomyCheckpoints>,
) {
  return {
    sequence: row.sequence,
    action: row.action as ParserAction,
    status: row.status as AutonomyStatus,
    output: row.output,
    outputChars: row.outputChars,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createManacostTeamService(options: ManacostTeamServiceOptions) {
  const { database } = options;
  const inFlightRuns = new Set<string>();

  async function profile(): Promise<AutonomyProfile> {
    const [existing] = await database
      .select()
      .from(manacostAutonomyProfiles)
      .where(eq(manacostAutonomyProfiles.id, MANACOST_AUTONOMY_PROFILE_ID))
      .limit(1);
    if (existing) return profileFromRow(existing);
    await database
      .insert(manacostAutonomyProfiles)
      .values({ id: MANACOST_AUTONOMY_PROFILE_ID })
      .onConflictDoNothing();
    const [created] = await database
      .select()
      .from(manacostAutonomyProfiles)
      .where(eq(manacostAutonomyProfiles.id, MANACOST_AUTONOMY_PROFILE_ID))
      .limit(1);
    if (!created)
      throw new Error("The ManacostTeam autonomy profile is unavailable.");
    return profileFromRow(created);
  }

  async function updateProfile(
    updatedBy: string,
    input: Partial<
      Pick<
        AutonomyProfile,
        "maxSteps" | "maxDurationMs" | "maxRetries" | "maxOutputChars"
      >
    >,
  ) {
    const current = await profile();
    const next = {
      maxSteps:
        input.maxSteps === undefined
          ? current.maxSteps
          : validNumber(input.maxSteps, 1, 100, "maxSteps"),
      maxDurationMs:
        input.maxDurationMs === undefined
          ? current.maxDurationMs
          : validNumber(input.maxDurationMs, 1000, 86_400_000, "maxDurationMs"),
      maxRetries:
        input.maxRetries === undefined
          ? current.maxRetries
          : validNumber(input.maxRetries, 0, 10, "maxRetries"),
      maxOutputChars:
        input.maxOutputChars === undefined
          ? current.maxOutputChars
          : validNumber(
              input.maxOutputChars,
              1000,
              1_000_000,
              "maxOutputChars",
            ),
    };
    await database
      .update(manacostAutonomyProfiles)
      .set({
        ...next,
        automaticActions: [...AUTOMATIC_PARSER_ACTIONS],
        approvalActions: [...APPROVAL_PARSER_ACTIONS],
        updatedBy,
        updatedAt: new Date(),
      })
      .where(eq(manacostAutonomyProfiles.id, MANACOST_AUTONOMY_PROFILE_ID));
    return profile();
  }

  async function importCanonicalSkills() {
    const roots = options.canonicalRoots ?? [];
    const configuredRootIds = new Set<string>();
    for (const root of roots) {
      if (configuredRootIds.has(root.id)) {
        throw new ManacostTeamRefusedError(
          `Canonical root "${root.id}" is configured more than once.`,
        );
      }
      configuredRootIds.add(root.id);
    }
    const loaded = (
      await Promise.all(roots.map(loadCanonicalSkillRoot))
    ).flat();
    const loadedByRoot = new Map<string, Set<string>>();
    const loadedBySlug = new Map<string, string>();
    for (const skill of loaded) {
      const rootId = skill.provenance.rootId;
      const slugs = loadedByRoot.get(rootId) ?? new Set<string>();
      slugs.add(skill.slug);
      loadedByRoot.set(rootId, slugs);
      const previousRoot = loadedBySlug.get(skill.slug);
      if (previousRoot && previousRoot !== rootId) {
        throw new ManacostTeamRefusedError(
          `Canonical skill "${skill.slug}" is present in more than one root.`,
        );
      }
      loadedBySlug.set(skill.slug, rootId);
    }
    let imported = 0;
    let skipped = 0;
    let removed = 0;
    await database.transaction(async (transaction) => {
      // Canonical roots are authoritative for their own namespace. Remove a skill that was deleted
      // from a refreshed manifest, but leave skills from roots no longer configured untouched so a
      // temporary rollout typo cannot silently erase a different catalogue.
      const existingCanonical = await transaction
        .select({
          slug: skills.slug,
          sourceRoot: skills.sourceRoot,
          provenance: skills.provenance,
        })
        .from(skills)
        .where(eq(skills.origin, "canonical"));
      for (const row of existingCanonical) {
        const provenance = row.provenance as Record<string, unknown>;
        const rootId =
          typeof provenance.rootId === "string" ? provenance.rootId : null;
        const expected = rootId ? loadedByRoot.get(rootId) : undefined;
        if (
          !rootId ||
          !configuredRootIds.has(rootId) ||
          expected?.has(row.slug)
        )
          continue;
        await transaction
          .delete(pluginGrants)
          .where(
            and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.ref, row.slug)),
          );
        await transaction
          .delete(skills)
          .where(
            and(eq(skills.origin, "canonical"), eq(skills.slug, row.slug)),
          );
        removed += 1;
      }

      const existingBySlug = new Map(
        existingCanonical.map((row) => [row.slug, row]),
      );
      for (const skill of loaded) {
        const existing = existingBySlug.get(skill.slug);
        if (existing && existing.sourceRoot !== skill.sourceRoot) {
          throw new ManacostTeamRefusedError(
            `Canonical skill "${skill.slug}" is already owned by another root.`,
          );
        }
        const [saved] = await transaction
          .insert(skills)
          .values({
            id: skill.slug,
            slug: skill.slug,
            title: skill.title,
            summary: skill.summary,
            instructions: skill.instructions,
            origin: "canonical",
            sourceRoot: skill.sourceRoot,
            sourceRepo: skill.sourceRepo,
            sourceCommit: skill.sourceCommit,
            manifestHash: skill.manifestHash,
            companionFiles: skill.companionFiles,
            provenance: skill.provenance,
            installedBy: "manacost-team",
          })
          .onConflictDoUpdate({
            target: skills.slug,
            setWhere: eq(skills.origin, "canonical"),
            set: {
              title: skill.title,
              summary: skill.summary,
              instructions: skill.instructions,
              sourceRoot: skill.sourceRoot,
              sourceRepo: skill.sourceRepo,
              sourceCommit: skill.sourceCommit,
              manifestHash: skill.manifestHash,
              companionFiles: skill.companionFiles,
              provenance: skill.provenance,
              updatedAt: new Date(),
            },
          })
          .returning({ id: skills.id });
        if (!saved) {
          skipped += 1;
          continue;
        }
        await transaction
          .delete(skillTools)
          .where(eq(skillTools.skillId, saved.id));
        if (skill.tools.length > 0) {
          await transaction.insert(skillTools).values(
            skill.tools.map((ref) => ({
              skillId: saved.id,
              ref,
              declaredBy: "manacost-team",
            })),
          );
        }
        imported += 1;
      }
    });
    return {
      imported,
      skipped,
      removed,
      roots: roots.map((root) => root.id),
    };
  }

  async function catalogue() {
    const rows = await database
      .select({
        slug: skills.slug,
        title: skills.title,
        summary: skills.summary,
        sourceRepo: skills.sourceRepo,
        sourceCommit: skills.sourceCommit,
        manifestHash: skills.manifestHash,
        provenance: skills.provenance,
      })
      .from(skills)
      .where(eq(skills.origin, "canonical"))
      .orderBy(asc(skills.title));
    return rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      // Keep the public projection explicit: a corrupt or future provenance payload must not
      // smuggle the absolute canonical root (or another server-only field) into the API.
      provenance: publicProvenance(row),
    }));
  }

  async function instructionsForAgent(agentId: string, slug: string) {
    if (slug.length > 255 || !CANONICAL_SKILL_ID.test(slug)) return null;
    const [skill] = await database
      .select({
        id: skills.id,
        slug: skills.slug,
        title: skills.title,
        summary: skills.summary,
        instructions: skills.instructions,
        companionFiles: skills.companionFiles,
      })
      .from(skills)
      .innerJoin(
        pluginGrants,
        and(
          eq(pluginGrants.kind, "skill"),
          eq(pluginGrants.ref, skills.slug),
          eq(pluginGrants.agentId, agentId),
        ),
      )
      .where(and(eq(skills.slug, slug), eq(skills.origin, "canonical")))
      .limit(1);
    if (!skill) return null;

    const declaredRows = await database
      .select({ ref: skillTools.ref })
      .from(skillTools)
      .where(eq(skillTools.skillId, skill.id))
      .orderBy(asc(skillTools.ref));
    const declared = declaredRows.map((row) => row.ref);
    const grantedRows = declared.length
      ? await database
          .select({ ref: pluginGrants.ref })
          .from(pluginGrants)
          .where(
            and(
              eq(pluginGrants.kind, "mcp"),
              eq(pluginGrants.agentId, agentId),
            ),
          )
      : [];
    return {
      slug: skill.slug,
      title: skill.title,
      summary: skill.summary,
      instructions: skill.instructions,
      companionFiles: skill.companionFiles,
      tools: filterDeclaredTools(
        declared,
        new Set(grantedRows.map((row) => row.ref)),
      ),
    };
  }

  async function getRun(id: string, actorId: string, isAdmin = false) {
    if (!UUID.test(id)) return null;
    const [row] = await database
      .select()
      .from(manacostAutonomyRuns)
      .where(
        and(
          eq(manacostAutonomyRuns.id, id),
          isAdmin ? undefined : eq(manacostAutonomyRuns.actorId, actorId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const checkpoints = await database
      .select()
      .from(manacostAutonomyCheckpoints)
      .where(eq(manacostAutonomyCheckpoints.runId, id))
      .orderBy(asc(manacostAutonomyCheckpoints.sequence));
    return {
      ...publicRun(row),
      checkpoints: checkpoints.map(publicCheckpoint),
    };
  }

  function checkpointValues(
    runId: string,
    sequence: number,
    action: ParserAction,
    status: AutonomyStatus,
    output: unknown,
    outputChars: number,
  ) {
    return {
      runId,
      sequence,
      action,
      status,
      output:
        output && typeof output === "object" && !Array.isArray(output)
          ? (output as Record<string, unknown>)
          : { value: output },
      outputChars,
    };
  }

  /** Terminal status and its evidence become visible together, never as a half-finished run. */
  async function finishRun(input: {
    runId: string;
    sequence: number;
    action: ParserAction;
    status: Extract<AutonomyStatus, "blocked" | "completed" | "failed">;
    output: unknown;
    outputChars: number;
    lastError?: string;
    totalOutputChars?: number;
  }) {
    await database.transaction(async (transaction) => {
      await transaction
        .update(manacostAutonomyRuns)
        .set({
          status: input.status,
          ...(input.lastError ? { lastError: input.lastError } : {}),
          ...(input.totalOutputChars === undefined
            ? {}
            : { outputChars: input.totalOutputChars }),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(manacostAutonomyRuns.id, input.runId));
      await transaction
        .insert(manacostAutonomyCheckpoints)
        .values(
          checkpointValues(
            input.runId,
            input.sequence,
            input.action,
            input.status,
            input.output,
            input.outputChars,
          ),
        );
    });
  }

  async function executeRun(runId: string, action: ParserAction) {
    if (inFlightRuns.has(runId)) {
      const [active] = await database
        .select({ actorId: manacostAutonomyRuns.actorId })
        .from(manacostAutonomyRuns)
        .where(eq(manacostAutonomyRuns.id, runId))
        .limit(1);
      return active ? getRun(runId, active.actorId) : null;
    }
    inFlightRuns.add(runId);
    try {
      const [run] = await database
        .select()
        .from(manacostAutonomyRuns)
        .where(eq(manacostAutonomyRuns.id, runId))
        .limit(1);
      if (!run)
        throw new ManacostTeamRefusedError("The autonomy run does not exist.");
      if (run.status !== "running") return getRun(runId, run.actorId);
      if (run.action !== action) {
        throw new ManacostTeamRefusedError(
          "The requested action does not match the autonomy run.",
        );
      }

      const limits = await profile();
      if (
        !limits.automaticActions.includes(action as AutomaticParserAction) &&
        !limits.approvalActions.includes(action as ApprovalParserAction)
      ) {
        throw new ManacostTeamRefusedError(
          "The action is not enabled by the server-owned profile.",
        );
      }
      const retry = action === "retry";
      const elapsed = Date.now() - run.startedAt.getTime();
      const nextStep = run.step + 1;
      if (elapsed >= limits.maxDurationMs) {
        await finishRun({
          runId,
          sequence: nextStep,
          action,
          status: "blocked",
          lastError: "The run exceeded its time limit.",
          output: { reason: "time_limit" },
          outputChars: 0,
        });
        return getRun(runId, run.actorId);
      }
      if (nextStep > limits.maxSteps) {
        await finishRun({
          runId,
          sequence: nextStep,
          action,
          status: "blocked",
          lastError: "The run exceeded its step limit.",
          output: { reason: "step_limit" },
          outputChars: 0,
        });
        return getRun(runId, run.actorId);
      }
      if (retry && run.retries >= limits.maxRetries) {
        await finishRun({
          runId,
          sequence: nextStep,
          action,
          status: "blocked",
          lastError: "The run exceeded its retry limit.",
          output: { reason: "retry_limit" },
          outputChars: 0,
        });
        return getRun(runId, run.actorId);
      }

      const claimed = await database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(manacostAutonomyRuns)
          .set({
            step: nextStep,
            retries: retry ? run.retries + 1 : run.retries,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(manacostAutonomyRuns.id, runId),
              eq(manacostAutonomyRuns.status, "running"),
              eq(manacostAutonomyRuns.step, run.step),
            ),
          )
          .returning();
        if (!updated) return null;
        await transaction
          .insert(manacostAutonomyCheckpoints)
          .values(
            checkpointValues(
              runId,
              nextStep,
              action,
              "running",
              { workspace: "isolated-parser-ops" },
              0,
            ),
          );
        return updated;
      });
      if (!claimed) return getRun(runId, run.actorId);

      try {
        if (!options.executeParserAction) {
          throw new Error("The isolated parser executor is not configured.");
        }
        const remaining = Math.max(1, limits.maxDurationMs - elapsed);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AutonomyBoundError("The run exceeded its time limit."),
              ),
            remaining,
          );
        });
        const result = await Promise.race([
          options.executeParserAction({
            action,
            runId,
            actorId: run.actorId,
            botId: run.botId,
            input: validateRunInput(run.input),
          }),
          timeout,
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        const output = jsonText(result);
        const outputChars = run.outputChars + output.length;
        if (outputChars > limits.maxOutputChars) {
          throw new AutonomyBoundError("The run exceeded its output limit.");
        }
        await finishRun({
          runId,
          sequence: nextStep + 1,
          action,
          status: "completed",
          output: { text: output },
          outputChars: output.length,
          totalOutputChars: outputChars,
        });
      } catch (error) {
        const bounded = error instanceof AutonomyBoundError;
        const message = safeError(error);
        await finishRun({
          runId,
          sequence: nextStep + 1,
          action,
          status: bounded ? "blocked" : "failed",
          lastError: message,
          output: { error: message },
          outputChars: 0,
        });
      }
      return getRun(runId, run.actorId);
    } finally {
      inFlightRuns.delete(runId);
    }
  }

  function scheduleRun(runId: string, action: ParserAction) {
    void executeRun(runId, action).catch(async (error) => {
      const message = safeError(error);
      try {
        await database
          .update(manacostAutonomyRuns)
          .set({
            status: "failed",
            lastError: message,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(manacostAutonomyRuns.id, runId),
              eq(manacostAutonomyRuns.status, "running"),
            ),
          );
      } catch {
        // A database outage must not create an unhandled rejection; the next status read exposes the last durable state.
      }
    });
  }

  async function startRun(input: {
    actorId: string;
    botId: string;
    skillSlug: string;
    action: ParserAction;
    input?: Record<string, unknown>;
  }) {
    const skillSlug = canonicalSkillSlug(input.skillSlug);
    const limits = await profile();
    const isAutomatic = limits.automaticActions.includes(
      input.action as AutomaticParserAction,
    );
    const isApproval = limits.approvalActions.includes(
      input.action as ApprovalParserAction,
    );
    if (!isAutomatic && !isApproval) {
      throw new ManacostTeamRefusedError(
        "The action is not enabled by the server-owned profile.",
      );
    }
    const skill = await instructionsForAgent(input.botId, skillSlug);
    if (!skill) {
      throw new ManacostTeamRefusedError(
        "This skill is not approved for this Bot.",
      );
    }
    const actionInput = validateRunInput(input.input ?? {});
    let encodedInput: string;
    try {
      encodedInput = JSON.stringify(actionInput) ?? "{}";
    } catch {
      throw new ManacostTeamRefusedError(
        "Run input must be JSON serializable.",
      );
    }
    if (encodedInput.length > MAX_RUN_INPUT_CHARS) {
      throw new ManacostTeamRefusedError(
        "Run input is larger than the bounded input limit.",
      );
    }
    const created = await database.transaction(async (transaction) => {
      const [run] = await transaction
        .insert(manacostAutonomyRuns)
        .values({
          actorId: input.actorId,
          botId: input.botId,
          skillSlug,
          action: input.action,
          input: actionInput,
          status: isApproval ? "awaiting_approval" : "running",
        })
        .returning();
      if (!run) throw new Error("The autonomy run could not be created.");
      const token = isApproval
        ? mintManacostApproval(
            { runId: run.id, action: input.action as ApprovalParserAction },
            options.encryptionKey,
          )
        : null;
      await transaction.insert(manacostAutonomyCheckpoints).values({
        runId: run.id,
        sequence: 0,
        action: input.action,
        status: isApproval ? "awaiting_approval" : "running",
        output: { workspace: "isolated-parser-ops" },
        outputChars: 0,
      });
      if (token) {
        await transaction.insert(manacostAutonomyApprovals).values({
          runId: run.id,
          action: input.action,
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt,
        });
      }
      return { run, token };
    });
    if (!isApproval) scheduleRun(created.run.id, input.action);
    return {
      run: await getRun(created.run.id, input.actorId),
      approvalToken: created.token?.token ?? null,
      tools: skill.tools,
    };
  }

  async function approveRun(input: { runId: string; token: unknown }) {
    const parsed = readManacostApproval(input.token, options.encryptionKey);
    if (!parsed || parsed.runId !== input.runId) {
      throw new ManacostTeamRefusedError("The approval is invalid or expired.");
    }
    const tokenHash = sha256(input.token as string);
    const now = new Date();
    const run = await database.transaction(async (transaction) => {
      const [approval] = await transaction
        .select()
        .from(manacostAutonomyApprovals)
        .where(
          and(
            eq(manacostAutonomyApprovals.runId, parsed.runId),
            eq(manacostAutonomyApprovals.action, parsed.action),
            eq(manacostAutonomyApprovals.tokenHash, tokenHash),
            isNull(manacostAutonomyApprovals.consumedAt),
            gt(manacostAutonomyApprovals.expiresAt, now),
          ),
        )
        .limit(1);
      if (!approval)
        throw new ManacostTeamRefusedError(
          "The approval is invalid, expired, or already used.",
        );
      const [consumed] = await transaction
        .update(manacostAutonomyApprovals)
        .set({ consumedAt: now })
        .where(
          and(
            eq(manacostAutonomyApprovals.id, approval.id),
            isNull(manacostAutonomyApprovals.consumedAt),
          ),
        )
        .returning({ id: manacostAutonomyApprovals.id });
      if (!consumed)
        throw new ManacostTeamRefusedError("The approval was already used.");
      const [updated] = await transaction
        .update(manacostAutonomyRuns)
        .set({ status: "running", updatedAt: now })
        .where(
          and(
            eq(manacostAutonomyRuns.id, parsed.runId),
            eq(manacostAutonomyRuns.status, "awaiting_approval"),
          ),
        )
        .returning({ id: manacostAutonomyRuns.id });
      if (!updated)
        throw new ManacostTeamRefusedError(
          "The autonomy run is no longer awaiting approval.",
        );
      return updated;
    });
    scheduleRun(run.id, parsed.action);
    return getRun(run.id, "", true);
  }

  /** Re-queue a durable run left in `running` after a worker restart. */
  async function resumeRun(input: {
    runId: string;
    actorId: string;
    isAdmin?: boolean;
  }) {
    const current = await getRun(
      input.runId,
      input.actorId,
      input.isAdmin === true,
    );
    if (!current) return null;
    if (current.status !== "running") {
      throw new ManacostTeamRefusedError(
        "Only an interrupted running autonomy run can be resumed.",
      );
    }
    scheduleRun(input.runId, current.action);
    return getRun(input.runId, input.actorId, input.isAdmin === true);
  }

  return {
    profile,
    updateProfile,
    importCanonicalSkills,
    catalogue,
    instructionsForAgent,
    getRun,
    startRun,
    approveRun,
    resumeRun,
  };
}

export type ManacostTeamService = ReturnType<typeof createManacostTeamService>;
