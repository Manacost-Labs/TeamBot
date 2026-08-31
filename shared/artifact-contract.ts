/** Canonical first-party tool whose result may become an artifact card. */
export const CREATE_ARTIFACT_TOOL_NAME =
  "mcp__artifacts__create_artifact" as const;
/** Safe wire alias used by the remote Codex adapter because `mcp__` is reserved by AG-UI. */
export const REMOTE_CREATE_ARTIFACT_TOOL_NAME =
  "openbot__artifacts__create_artifact" as const;

export const ARTIFACT_RESULT_SCHEMA = "openbot.artifact.v1" as const;

export const ARTIFACT_MIME_TYPES = [
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "image/svg+xml",
  "text/html",
  "application/pdf",
] as const;

export type ArtifactMimeType = (typeof ARTIFACT_MIME_TYPES)[number];

export const ARTIFACT_EXTENSION_BY_MIME_TYPE: Readonly<
  Record<ArtifactMimeType, string>
> = Object.freeze({
  "text/markdown": ".md",
  "text/plain": ".txt",
  "application/json": ".json",
  "text/csv": ".csv",
  "image/svg+xml": ".svg",
  "text/html": ".html",
  "application/pdf": ".pdf",
});

export type ArtifactResult = Readonly<{
  schema: typeof ARTIFACT_RESULT_SCHEMA;
  artifact: Readonly<{
    attachmentId: string;
    filename: string;
    mimeType: ArtifactMimeType;
    size: number;
    title: string;
  }>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MIME_TYPES = new Set<string>(ARTIFACT_MIME_TYPES);
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function isArtifactMimeType(value: string): value is ArtifactMimeType {
  return MIME_TYPES.has(value);
}

export function artifactFilenameMatchesMimeType(
  filename: string,
  mimeType: ArtifactMimeType,
): boolean {
  return (
    filename === filename.normalize("NFC").trim() &&
    filename.length > 0 &&
    [...filename].length <= 255 &&
    !hasControl(filename) &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !filename.startsWith(".") &&
    !filename.endsWith(".") &&
    !/^[a-z]:/iu.test(filename) &&
    !WINDOWS_RESERVED_NAME.test(filename) &&
    filename.toLowerCase().endsWith(ARTIFACT_EXTENSION_BY_MIME_TYPE[mimeType])
  );
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
  });
}

/**
 * Parse the deliberately small, versioned value persisted in an AG-UI tool message.
 *
 * The transcript is untrusted history. Returning a fresh projection rather than the parsed object
 * prevents extra fields from silently becoming part of the browser contract. Attachment metadata
 * is still fetched from the authenticated API before it is displayed or linked.
 */
export function parseArtifactResult(value: unknown): ArtifactResult | null {
  if (!isRecord(value) || value.schema !== ARTIFACT_RESULT_SCHEMA) return null;
  const artifact = value.artifact;
  if (!isRecord(artifact)) return null;

  const { attachmentId, filename, mimeType, size, title } = artifact;
  if (
    typeof attachmentId !== "string" ||
    !UUID.test(attachmentId) ||
    typeof filename !== "string" ||
    filename.length === 0 ||
    typeof mimeType !== "string" ||
    !isArtifactMimeType(mimeType) ||
    !artifactFilenameMatchesMimeType(filename, mimeType) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    typeof title !== "string" ||
    title.length === 0
  ) {
    return null;
  }

  return {
    schema: ARTIFACT_RESULT_SCHEMA,
    artifact: {
      attachmentId,
      filename,
      mimeType,
      size,
      title,
    },
  };
}

/** Parse only the exact built-in tool; matching payloads from other tools remain ordinary results. */
export function parseArtifactToolResult(
  toolName: string,
  result: string | undefined,
): ArtifactResult | null {
  if (!isCreateArtifactToolName(toolName) || result === undefined) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(result);
    // The runtime may JSON-encode a tool's string once more when persisting the tool message.
    return parseArtifactResult(
      typeof parsed === "string" ? JSON.parse(parsed) : parsed,
    );
  } catch {
    return null;
  }
}

export function isCreateArtifactToolName(toolName: string): boolean {
  return (
    toolName === CREATE_ARTIFACT_TOOL_NAME ||
    toolName === REMOTE_CREATE_ARTIFACT_TOOL_NAME
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
