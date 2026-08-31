import type { RunAgentInput } from "@ag-ui/core";
import { projectMessageContent } from "../../shared/message-content";

const MAX_VIDEOS = 5;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVIDENCE_WINDOWS = 80;
const MAX_WINDOW_TEXT = 1_200;
const DEFAULT_TIMEOUT_MS = 70_000;
const DEFAULT_SOURCE_URL = "http://research-sources:8777";

type JsonObject = Record<string, unknown>;

export type YoutubeTranscriptContextOptions = {
  fetchImpl?: typeof fetch;
  sourceUrl?: string;
  token?: string;
  timeoutMs?: number;
};

export function youtubeVideoUrls(input: RunAgentInput): string[] {
  const latest = input.messages.findLast((message) => message.role === "user");
  if (!latest) return [];
  const text = projectMessageContent(latest.content, "user");
  const videoIds: string[] = [];
  const seen = new Set<string>();
  const add = (videoId: string) => {
    if (seen.has(videoId)) return;
    seen.add(videoId);
    videoIds.push(videoId);
  };

  const urlPattern =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s<>]*?\bv=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[^\s<>]*)?/gi;
  for (const match of text.matchAll(urlPattern)) {
    const videoId = match[1];
    if (videoId) add(videoId);
  }

  const idPattern =
    /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{11})(?=$|[^A-Za-z0-9_-])/g;
  for (const match of text.matchAll(idPattern)) {
    const videoId = match[1];
    if (videoId) add(videoId);
  }

  return videoIds.map(
    (videoId) => `https://www.youtube.com/watch?v=${videoId}`,
  );
}

export async function youtubeTranscriptContext(
  input: RunAgentInput,
  options: YoutubeTranscriptContextOptions = {},
): Promise<string> {
  const urls = youtubeVideoUrls(input);
  if (urls.length === 0) {
    return youtubeContextBlock({
      status: "no_video_links",
      results: [],
    });
  }
  if (urls.length > MAX_VIDEOS) {
    return youtubeContextBlock({
      status: "too_many_video_links",
      supplied: urls.length,
      maximum: MAX_VIDEOS,
      results: urls.map((sourceUrl) => ({
        sourceUrl,
        status: "not_requested",
      })),
    });
  }

  const sourceUrl = (
    options.sourceUrl ??
    process.env.RESEARCH_SOURCES_URL ??
    DEFAULT_SOURCE_URL
  ).replace(/\/$/, "");
  const token =
    options.token ?? process.env.RESEARCH_SOURCE_GATEWAY_TOKEN?.trim() ?? "";
  if (!token) {
    return youtubeContextBlock({
      status: "gateway_unavailable",
      results: urls.map((videoUrl) => ({
        sourceUrl: videoUrl,
        status: "provider_error",
        reason: "internal_gateway_not_configured",
      })),
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const results = await Promise.all(
    urls.map((videoUrl) =>
      fetchTranscript(fetchImpl, sourceUrl, token, videoUrl, timeoutMs),
    ),
  );
  return youtubeContextBlock({ status: "ready", results });
}

async function fetchTranscript(
  fetchImpl: typeof fetch,
  sourceUrl: string,
  token: string,
  videoUrl: string,
  timeoutMs: number,
): Promise<JsonObject> {
  try {
    const response = await fetchImpl(`${sourceUrl}/v1/source`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-source-gateway-token": token,
      },
      body: JSON.stringify({
        command: "youtube-transcript",
        options: { video: videoUrl },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      return transcriptFailure(
        videoUrl,
        "provider_response_too_large",
        response.status,
      );
    }
    const payload = parseObject(body);
    if (!response.ok || payload?.ok !== true) {
      return transcriptFailure(
        videoUrl,
        failureCode(payload) ?? "provider_error",
        response.status,
        failureRetryable(payload),
      );
    }

    const data = isObject(payload.data) ? payload.data : undefined;
    const result = Array.isArray(data?.results)
      ? data.results.find(isObject)
      : undefined;
    if (!result) {
      return transcriptFailure(
        videoUrl,
        "captions_unavailable",
        response.status,
      );
    }
    const windows = Array.isArray(result.evidence_windows)
      ? result.evidence_windows
          .filter(isObject)
          .slice(0, MAX_EVIDENCE_WINDOWS)
          .map(compactWindow)
      : [];
    if (windows.length === 0) {
      return transcriptFailure(
        videoUrl,
        typeof result.evidence_status === "string"
          ? result.evidence_status
          : "captions_unavailable",
        response.status,
      );
    }

    return compactTranscript(videoUrl, data ?? {}, result, windows);
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === "TimeoutError"
        ? "provider_timeout"
        : "provider_request_failed";
    return transcriptFailure(videoUrl, reason);
  }
}

function compactTranscript(
  requestedUrl: string,
  data: JsonObject,
  result: JsonObject,
  evidenceWindows: JsonObject[],
): JsonObject {
  return withoutUndefined({
    status: "available",
    requestedUrl,
    sourceUrl: safeYoutubeUrl(result.source_url) ?? requestedUrl,
    sourceId: boundedString(result.source_id, 100),
    captionProvider: boundedString(result.caption_provider, 100),
    languageRequested: boundedString(result.language_requested, 30),
    translatedTo: boundedString(result.translated_to, 30),
    segmentCount: safeInteger(result.segment_count),
    contentHash: boundedString(result.content_hash, 160),
    collectedAt: boundedString(data.collected_at, 80),
    warnings: Array.isArray(data.warnings)
      ? data.warnings
          .filter((warning): warning is string => typeof warning === "string")
          .slice(0, 10)
          .map((warning) => warning.slice(0, 500))
      : [],
    evidenceWindows,
  });
}

function compactWindow(window: JsonObject): JsonObject {
  return withoutUndefined({
    start: safeNumber(window.start),
    end: safeNumber(window.end),
    segmentCount: safeInteger(window.segment_count),
    text: boundedString(window.text, MAX_WINDOW_TEXT),
    timestampUrl: safeYoutubeUrl(window.timestamp_url),
  });
}

function transcriptFailure(
  sourceUrl: string,
  reason: string,
  httpStatus?: number,
  retryable?: boolean,
): JsonObject {
  return withoutUndefined({
    status: "unavailable",
    sourceUrl,
    reason: reason.slice(0, 100),
    httpStatus,
    retryable,
  });
}

function failureCode(payload: JsonObject | undefined): string | undefined {
  const error = isObject(payload?.error) ? payload.error : undefined;
  return boundedString(error?.code, 100) ?? boundedString(error?.status, 100);
}

function failureRetryable(
  payload: JsonObject | undefined,
): boolean | undefined {
  const error = isObject(payload?.error) ? payload.error : undefined;
  return typeof error?.retryable === "boolean" ? error.retryable : undefined;
}

function youtubeContextBlock(payload: JsonObject): string {
  return [
    '<youtube_transcript_data trust="untrusted">',
    JSON.stringify(payload),
    "</youtube_transcript_data>",
  ].join("\n");
}

function parseObject(value: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeYoutubeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "youtube.com" ||
        url.hostname === "www.youtube.com" ||
        url.hostname === "youtu.be")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function positiveTimeout(value: number | undefined): number {
  const candidate = value ?? Number(process.env.YOUTUBE_TRANSCRIPT_TIMEOUT_MS);
  return Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : DEFAULT_TIMEOUT_MS;
}
