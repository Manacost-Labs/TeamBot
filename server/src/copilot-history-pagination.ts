import { createHash } from "node:crypto";

export const THREAD_HISTORY_PAGE_SIZE = 60;
const MAX_HISTORY_CURSOR_LENGTH = 2_048;
const MAX_HISTORY_MESSAGE_ID_LENGTH = 1_024;
const HISTORY_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const HISTORY_REVISION_PATTERN = /^sha256:[A-Za-z0-9_-]{32}$/;

export type PaginatedThreadMessages<T> = {
  messages: T[];
  olderCursor: string | null;
  hasOlder: boolean;
  revision: string;
};

export class InvalidHistoryCursor extends Error {
  constructor(message = "The conversation history cursor is no longer valid.") {
    super(message);
    this.name = "InvalidHistoryCursor";
  }
}

type HistoryCursor = {
  beforeId: string;
  revision: string;
  version: 1;
};

/**
 * Return one bounded chronological page from a full upstream history.
 *
 * The upstream Intelligence client currently exposes the complete thread only. This boundary keeps
 * that implementation detail on the server: the browser receives at most 60 rows, and the cursor
 * contains an opaque message boundary plus a revision guard rather than an array offset.
 */
export function paginateThreadMessages<T extends { id?: unknown }>(
  messages: readonly T[],
  beforeCursor?: string | null,
  limit = THREAD_HISTORY_PAGE_SIZE,
): PaginatedThreadMessages<T> {
  const pageSize = Math.max(
    1,
    Math.min(THREAD_HISTORY_PAGE_SIZE, Math.floor(limit)),
  );
  const revision = revisionFor(messages);
  let end = messages.length;

  if (beforeCursor) {
    const cursor = decodeCursor(beforeCursor);
    if (cursor.revision !== revision) {
      throw new InvalidHistoryCursor(
        "The conversation changed; reload its latest page.",
      );
    }
    const boundary = messages.findIndex(
      (message) => messageId(message) === cursor.beforeId,
    );
    if (boundary < 0) {
      throw new InvalidHistoryCursor();
    }
    end = boundary;
  }

  const start = Math.max(0, end - pageSize);
  const page = messages.slice(start, end);
  const boundaryId = page.length > 0 ? messageId(page[0]) : null;
  const olderCursor =
    start > 0 && boundaryId !== null
      ? encodeCursor({ beforeId: boundaryId, revision, version: 1 })
      : null;

  return {
    hasOlder: olderCursor !== null,
    messages: page,
    olderCursor,
    revision,
  };
}

/** Reject malformed or oversized cursors before an upstream history read is attempted. */
export function validateHistoryCursor(value: string): void {
  decodeCursor(value);
}

function messageId<T extends { id?: unknown }>(message: T): string | null {
  return typeof message.id === "string" &&
    message.id.length > 0 &&
    message.id.length <= MAX_HISTORY_MESSAGE_ID_LENGTH
    ? message.id
    : null;
}

function revisionFor<T>(messages: readonly T[]): string {
  const hash = createHash("sha256");
  for (const [index, message] of messages.entries()) {
    hash.update(`${index}:`);
    try {
      hash.update(JSON.stringify(message) ?? "undefined");
    } catch {
      hash.update(String(message));
    }
    hash.update("\n");
  }
  return `sha256:${hash.digest("base64url").slice(0, 32)}`;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): HistoryCursor {
  try {
    if (
      value.length === 0 ||
      value.length > MAX_HISTORY_CURSOR_LENGTH ||
      !HISTORY_CURSOR_PATTERN.test(value)
    ) {
      throw new Error("invalid encoding");
    }
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<HistoryCursor>;
    if (
      decoded.version !== 1 ||
      typeof decoded.beforeId !== "string" ||
      decoded.beforeId.length === 0 ||
      decoded.beforeId.length > MAX_HISTORY_MESSAGE_ID_LENGTH ||
      typeof decoded.revision !== "string" ||
      !HISTORY_REVISION_PATTERN.test(decoded.revision)
    ) {
      throw new Error("invalid shape");
    }
    return {
      beforeId: decoded.beforeId,
      revision: decoded.revision,
      version: 1,
    };
  } catch {
    throw new InvalidHistoryCursor();
  }
}
