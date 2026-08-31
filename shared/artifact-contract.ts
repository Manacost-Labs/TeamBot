/** The one first-party tool whose result may become an artifact card. */
export const CREATE_ARTIFACT_TOOL_NAME =
  "mcp__artifacts__create_artifact" as const;

export const ARTIFACT_RESULT_SCHEMA = "openbot.artifact.v1" as const;

export const ARTIFACT_MIME_TYPES = [
  "text/markdown",
  "application/pdf",
] as const;

export type ArtifactMimeType = (typeof ARTIFACT_MIME_TYPES)[number];

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
    !MIME_TYPES.has(mimeType) ||
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
      mimeType: mimeType as ArtifactMimeType,
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
  if (toolName !== CREATE_ARTIFACT_TOOL_NAME || result === undefined) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
