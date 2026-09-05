import type { Message } from "@ag-ui/core";
import { useRenderToolCall } from "@copilotkit/react-core/v2";
import {
  IconBox,
  IconChevronDown,
  IconDownload,
  IconFile,
} from "@tabler/icons-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { ThinkingOrb } from "thinking-orbs";
import { ArtifactCard } from "@/components/channels/artifact-card";
import { GoogleWorkspaceCard } from "@/components/channels/google-workspace-card";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  MessageContent,
  MessageFooter,
  Message as MessageRow,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ArtifactMetadata,
  listChannelArtifacts,
} from "@/lib/artifacts/api";
import {
  isCreateArtifactToolName,
  parseArtifactToolResult,
} from "@/lib/artifacts/contract";
import { attachmentDownloadUrl } from "@/lib/attachments/api";
import type { AttachmentMessageReference } from "@/lib/attachments/message-content";
import {
  anchoredScrollTop,
  conversationStateCache,
  TRANSCRIPT_HISTORY_PAGE_SIZE,
  TRANSCRIPT_HISTORY_WINDOW_MAX,
} from "@/lib/channels/conversation-state";
import type { HistoryPage } from "@/lib/copilot/conversation-store";
import { type AgentRunState, formatElapsedMs } from "@/lib/copilot/run-state";
import { StreamTextScheduler } from "@/lib/copilot/stream-text-scheduler";
import { parseGoogleWorkspaceResult } from "@/lib/google-workspace/result";
import { markdownComponents, markdownUrlTransform } from "@/lib/markdown";
import {
  abandonArtifactRenderTiming,
  beginArtifactRenderTiming,
} from "@/lib/performance/workspace-timing";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, forDisplay, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import {
  type ActivitySnapshot,
  activitySnapshotFor,
  projectTranscriptWindow,
} from "./chat-messages";
import type { QueuedMessage } from "./composer";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine } from "./tool-line";

type ChatTranscriptProps = {
  busy?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<HistoryPage | null>;
  /** Comma-separated `/` command names, used to tell a skill chip from a leading slash. */
  commandNames?: string;
  messages: ReadonlyArray<Readonly<Message>>;
  /**
   * Typed while the Bot had the turn, and waiting for it to finish. Empty on a screen that does not
   * offer queueing at all.
   */
  queued?: readonly QueuedMessage[];
  /** Take one back before it runs. Without it a queued line is shown but cannot be undone. */
  onRemoveQueued?: (id: string) => void;
  /** History has been asked for and has not arrived. Drawn only when there is nothing else to draw. */
  restoring?: boolean;
  /** Explicit lifecycle state; transcript inference remains a fallback. */
  run?: AgentRunState;
  /** Bounded in-memory UI state key for draft-adjacent transcript position and history window. */
  conversationKey?: string;
  /** Query generated files when history omitted the AG-UI artifact result envelope. */
  recoverArtifacts?: boolean;
  /** Channel used for authenticated artifact metadata and bytes. Falls back to conversationKey. */
  channelId?: string;
  /** Deterministic render-count seam used by transcript performance regression tests. */
  onRowRender?: (id: string) => void;
  /** Re-send the last failed request without making a duplicate while another turn is active. */
  onRetry?: () => void;
  /**
   * Why the last turn ended without an answer, if it did.
   *
   * A sentence rather than a flag, because the reasons are not interchangeable: a Bot that refused,
   * a Bot whose endpoint is down and a Bot that simply stopped talking are three different things to
   * be told, and only the thing that ended the turn knows which one happened.
   */
  stopped?: string;
};

/** One shared empty array, so a screen without a queue does not hand down a new one per render. */
const EMPTY_QUEUE: readonly QueuedMessage[] = [];
const EMPTY_ATTACHMENTS_JSON = "[]";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type HistoryWindowState = {
  /** Null follows the live tail; an id pins the first mounted row while reading older history. */
  startId: string | null;
  size: number;
};

/**
 * Split a person's message into the skill they invoked and the rest of what they typed.
 *
 * ONLY A KNOWN COMMAND COUNTS. "/etc/hosts is broken" is a sentence, not a skill, and drawing a chip
 * around it would invent a thing that never happened. The names come from the same list the `/` menu
 * was built from, so this stays true as skills are granted and revoked.
 *
 * The trigger only opens at the start of a line, so the chip is the first token or there is none.
 */
function splitSkillChip(
  text: string,
  commandNames: string,
): { chip: string; rest: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(\s|$)/.exec(text);
  if (!match) {
    return null;
  }
  const known = commandNames.split(",").filter(Boolean);
  if (!known.includes(match[1])) {
    return null;
  }
  return { chip: match[1], rest: text.slice(match[0].length) };
}

/**
 * The shape of a conversation, while it is still being fetched. Shaped like what is coming rather
 * than like a loading widget, on the same line pitch so the column does not jump when words land.
 */
const RESTORING_ANSWER_LINES = [
  { id: "line-1", width: "w-full" },
  { id: "line-2", width: "w-11/12" },
  { id: "line-3", width: "w-full" },
  { id: "line-4", width: "w-10/12" },
  { id: "line-5", width: "w-11/12" },
  { id: "line-6", width: "w-full" },
  { id: "line-7", width: "w-11/12" },
  { id: "line-8", width: "w-2/3" },
] as const;

function RestoringTranscript() {
  return (
    // One announcement, with every bar hidden from it: nine empty shapes read aloud is worse.
    <div aria-label="Загрузка диалога" role="status">
      <div aria-hidden="true" className="flex justify-end pb-7">
        <Skeleton className="h-10 w-64 rounded-xl bg-muted/40 motion-reduce:animate-none" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3">
        {RESTORING_ANSWER_LINES.map((line) => (
          <Skeleton
            className={`h-4 bg-muted/40 motion-reduce:animate-none ${line.width}`}
            key={line.id}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The turn ended and no answer came.
 *
 * In the same slot as `Thinking`, and for the same reason it is there: the person is looking at the
 * bottom of the transcript, immediately under their own message, because that is where the answer
 * was going to appear. Saying so above the composer put the explanation in a different part of the
 * screen from the gap it explains, and left the last thing in the conversation looking unfinished.
 *
 * NOT A MESSAGE, deliberately. It has no id, is never anchored, and is gone the moment the next turn
 * starts. Making it a transcript row would put a sentence into the conversation that nobody said,
 * and the conversation is sent back to the model on the next turn, so the Bot would then read its
 * own obituary as something it had written.
 */
function Stopped({
  reason,
  onRetry,
}: {
  reason: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 text-destructive text-sm"
      data-testid="transcript-stopped"
      role="alert"
    >
      <span>{reason}</span>
      {onRetry ? (
        <button
          className="shrink-0 rounded-md border border-destructive/40 px-2 py-1 text-xs transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onRetry}
          type="button"
        >
          Повторить
        </button>
      ) : null}
    </div>
  );
}

/**
 * Something the person said while the Bot was working, waiting its turn.
 *
 * IT IS DRAWN AS THEIR MESSAGE, NOT AS A NOTICE ABOUT ONE. The whole point of letting somebody type
 * mid-turn is that they can see their words landed, and a status line saying "1 message queued"
 * does not do that — they would still be wondering whether the sentence they typed is the sentence
 * that will run. So it is the same bubble, in the same column, with the same wrapping, and only two
 * things say it has not run yet: it is faded, and it says so underneath.
 *
 * The footer carries the taking-back too, because that is where the reader's eye already is once
 * they have decided this was a mistake, and because a control on the bubble itself would have to
 * hover over the words it is offering to delete.
 */
function Queued({
  text,
  onRemove,
}: {
  text: string;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <Bubble align="end" className="opacity-60" variant="muted">
          <BubbleContent>
            {/* Shown exactly as typed, for the same reason a sent message is. */}
            <span className="whitespace-pre-wrap">{text}</span>
          </BubbleContent>
        </Bubble>
        <MessageFooter>
          {/*
           * `status` rather than `alert`, matching the thinking line: a person who has just chosen
           * to queue something is not being interrupted by the news that it is queued.
           */}
          <span role="status">В очереди</span>
          {onRemove ? (
            <button
              /*
               * The sentence it deletes, in the name. Three parked corrections put three buttons
               * called "Remove" in a row, and somebody reading by name alone is told what they can
               * do and nothing about which one it would happen to. The visible word stays short
               * because the bubble it sits under is the answer for everybody who can see it.
               */
              aria-label={`Удалить сообщение из очереди: ${text}`}
              className="ml-2 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={onRemove}
              type="button"
            >
              Удалить
            </button>
          ) : null}
        </MessageFooter>
      </MessageContent>
    </MessageRow>
  );
}

/**
 * Put the newest queued message where the person who just typed it can see it.
 *
 * Somebody may have deliberately scrolled upward while the Bot was answering. Sending a queued
 * correction is a new request to return to the live edge, so that one action explicitly resumes
 * following the end of the conversation.
 *
 * Keyed on the newest queued id rather than on the list, so it does not fire again for every chunk
 * of the answer still streaming above it, and stays quiet on a drain when the id goes to null.
 *
 * Rendering nothing and living inside the provider is what buys access to the scroller at all; the
 * alternative is threading a ref out through three components with no other reason to know a
 * scroller exists.
 */
function ScrollNewestQueuedIntoView({ newest }: { newest: string | null }) {
  const { scrollToEnd } = useMessageScroller();

  useEffect(() => {
    if (newest === null) {
      return;
    }
    scrollToEnd();
  }, [newest, scrollToEnd]);

  return null;
}

/** Stable layout wrapper. Only a newly appended live row gets the short entrance animation. */
function MessageLayout({
  arriving = false,
  children,
}: {
  arriving?: boolean;
  children: React.ReactNode;
}) {
  // Eligibility belongs to this mount. Later deltas must not cancel the running animation.
  const [animateEntrance] = useState(arriving);
  return (
    <div
      className={`flex w-full flex-col${animateEntrance ? " transcript-row-enter" : ""}`}
      data-slot="message-arriving"
    >
      {children}
    </div>
  );
}

/**
 * One drawn message, and it is memoised on PRIMITIVES ON PURPOSE.
 *
 * A streamed answer changes `messages` on every chunk, and `toVisibleChatItems` builds fresh objects
 * from it each time — so a memo comparing item objects would miss on every single one and buy
 * nothing. Passing role and text means an untouched message compares equal and is skipped.
 *
 * MEASURED, BEFORE AND AFTER. One reply into a 25-message thread cost 76 transcript renders and
 * 1,890 message renders, because every message in the history re-parsed its markdown on every
 * chunk. That is the jank: the scroll was following a list that rebuilt itself 76 times.
 *
 * It is also what keeps the entrance honest — no remount means no replay of the fade.
 */
const TranscriptMessage = memo(function TranscriptMessage({
  attachmentsJson = "[]",
  channelId,
  commandNames = "",
  id,
  onRender,
  role,
  streaming = false,
  text,
  arriving = false,
}: {
  attachmentsJson?: string;
  channelId?: string;
  commandNames?: string;
  id: string;
  onRender?: (id: string) => void;
  role: "user" | "assistant";
  streaming?: boolean;
  text: string;
  arriving?: boolean;
}) {
  onRender?.(id);
  const isUser = role === "user";
  const align = isUser ? "end" : "start";
  const invoked = isUser ? splitSkillChip(text, commandNames) : null;
  const attachments = JSON.parse(
    attachmentsJson,
  ) as AttachmentMessageReference[];

  return (
    <MessageRow align={align}>
      <MessageContent>
        <MessageLayout arriving={arriving}>
          {isUser && attachments.length > 0 ? (
            <AttachmentCards attachments={attachments} channelId={channelId} />
          ) : null}
          {/*
            A Bot's message takes the whole column, not the width of its words: block content
            inside it — a fenced code block, a table — should span the transcript rather than
            shrink to its own text. A person's bubble keeps fitting what they said.
          */}
          {text ? (
            <Bubble
              align={align}
              variant={isUser ? "muted" : "ghost"}
              className={
                isUser ? "max-w-[92%] rounded-2xl sm:max-w-[82%]" : "w-full"
              }
            >
              <BubbleContent
                className={isUser ? "rounded-2xl px-4 py-3 sm:px-5" : "w-full"}
              >
                {isUser ? (
                  // A person's own message is shown exactly as they typed it. Rendering it as markdown
                  // would silently reformat what they said, and an asterisk in a sentence is not
                  // emphasis. The chip is the one exception, and it is not reformatting: it is drawing
                  // the thing that was already a chip in the composer as a chip here too, so the
                  // transcript shows a skill was used rather than a slash that was typed.
                  <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {invoked ? (
                      <>
                        {/*
                         * The same icon the sidebar uses for Skills, so the badge says WHAT KIND of
                         * thing was invoked before it says which one. `inline-flex` with
                         * `align-middle` rather than a block: this sits mid-sentence, and a badge that
                         * breaks the line it is in reads as a separate message.
                         */}
                        <span className="mr-1 inline-flex items-center gap-1 rounded bg-foreground/10 px-1.5 py-0.5 align-middle font-mono text-foreground/80 text-xs">
                          <IconBox className="size-3 shrink-0" />/{invoked.chip}
                        </span>
                        {invoked.rest}
                      </>
                    ) : (
                      text
                    )}
                  </span>
                ) : (
                  /*
                   * A Bot's prose is markdown, and it arrives in pieces.
                   *
                   * Rendered with a streaming-aware renderer rather than an ordinary one: half a fenced
                   * code block or an unclosed bold marker is the NORMAL state for most of a run, and a
                   * plain markdown parser draws that as literal asterisks and backticks until the
                   * closing token arrives, so the answer visibly rewrites itself as it lands. This
                   * closes them for the duration.
                   */
                  <Streamdown
                    components={markdownComponents}
                    mode={streaming ? "streaming" : "static"}
                    urlTransform={markdownUrlTransform}
                  >
                    {text}
                  </Streamdown>
                )}
              </BubbleContent>
            </Bubble>
          ) : null}
        </MessageLayout>
      </MessageContent>
    </MessageRow>
  );
});

const RASTER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function AttachmentCards({
  attachments,
  channelId,
}: {
  attachments: readonly AttachmentMessageReference[];
  channelId?: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap justify-end gap-2">
      {attachments.map((attachment) => {
        const url = channelId
          ? attachmentDownloadUrl(channelId, attachment.id)
          : null;
        const preview =
          url && RASTER_IMAGE_MIME_TYPES.has(attachment.mimeType) ? url : null;
        const body = (
          <>
            {preview ? (
              <img
                alt={attachment.filename}
                className="h-24 w-full rounded-t-lg object-cover"
                loading="lazy"
                src={preview}
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded bg-background"
              >
                <IconFile className="size-5 text-muted-foreground" />
              </span>
            )}
            <span className="min-w-0 flex-1 px-1">
              <span
                className="block truncate text-xs"
                title={attachment.filename}
              >
                {attachment.filename}
              </span>
              <span className="block truncate text-muted-foreground text-xs">
                {attachment.mimeType}
              </span>
            </span>
            {url ? (
              <IconDownload aria-hidden="true" className="size-4 shrink-0" />
            ) : null}
          </>
        );

        return url ? (
          <a
            aria-label={`Скачать ${attachment.filename}`}
            className="flex min-w-44 max-w-60 items-center gap-2 rounded-lg border border-border bg-muted/30 p-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            download={attachment.filename}
            href={url}
            key={attachment.id}
          >
            {body}
          </a>
        ) : (
          <div
            className="flex min-w-44 max-w-60 items-center gap-2 rounded-lg border border-border bg-muted/30 p-2"
            key={attachment.id}
          >
            {body}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One drawn tool call, memoised on the same terms.
 *
 * The `toolCall` object is rebuilt here from its parts rather than passed down, because the one on
 * the message is a new object on every chunk and would defeat the memo exactly as the text items
 * did. A finished chart re-rendering on every token of the sentence after it is not free.
 *
 * MCP calls never ask the frontend registry to render them: they execute on the server and have no
 * browser hook. Keeping that path outside `RegisteredToolCall` also lets restored server history be
 * rendered before a Copilot provider has joined.
 */
const TranscriptToolCall = memo(function TranscriptToolCall({
  channelId,
  id,
  onRender,
  toolCallId,
  name,
  args,
  result,
  live,
  arriving = false,
}: {
  channelId?: string;
  id: string;
  onRender?: (id: string) => void;
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
  live?: boolean;
  arriving?: boolean;
}) {
  onRender?.(id);
  const artifact = parseArtifactToolResult(name, result)?.artifact ?? null;
  const googleWorkspaceResult = parseGoogleWorkspaceResult(name, result);
  const timingStarted = useRef(false);

  useEffect(() => {
    if (
      isCreateArtifactToolName(name) &&
      live &&
      result === undefined &&
      !timingStarted.current
    ) {
      timingStarted.current = true;
      beginArtifactRenderTiming(toolCallId);
    }
    if (result !== undefined && !artifact && timingStarted.current) {
      timingStarted.current = false;
      abandonArtifactRenderTiming(toolCallId);
    }
  }, [artifact, live, name, result, toolCallId]);

  useEffect(
    () => () => {
      if (timingStarted.current) abandonArtifactRenderTiming(toolCallId);
    },
    [toolCallId],
  );

  return (
    <MessageLayout arriving={arriving}>
      <ToolRenderBoundary name={name}>
        {artifact && channelId ? (
          <ArtifactCard
            artifact={artifact}
            channelId={channelId}
            trackPaint={timingStarted.current}
            toolCallId={toolCallId}
          />
        ) : googleWorkspaceResult ? (
          <GoogleWorkspaceCard result={googleWorkspaceResult} />
        ) : /^mcp(?:_h)?__/.test(name) ? (
          <ServerToolLine name={name} result={result} />
        ) : (
          <RegisteredToolCall
            args={args}
            name={name}
            result={result}
            toolCallId={toolCallId}
          />
        )}
      </ToolRenderBoundary>
    </MessageLayout>
  );
});

/** A browser-registered component or decision; unlike MCP tools, these may have a custom renderer. */
function RegisteredToolCall({
  toolCallId,
  name,
  args,
  result,
}: {
  toolCallId: string;
  name: string;
  args: string;
  result?: string;
}) {
  const renderToolCall = useRenderToolCall();
  const toolCall = useMemo(
    () => ({
      id: toolCallId,
      type: "function" as const,
      function: { name, arguments: args },
    }),
    [toolCallId, name, args],
  );

  const drawn = renderToolCall({
    toolCall,
    ...(result === undefined
      ? {}
      : {
          toolMessage: {
            id: `${toolCallId}-result`,
            role: "tool",
            toolCallId,
            content: result,
          },
        }),
  });
  return drawn ?? <ServerToolLine name={name} result={result} />;
}

/**
 * A tool the runtime executed, drawn for the person watching.
 *
 * Named from the reader's side: what was done, against which server, with the server's own words
 * behind a disclosure. The identifier the model was offered never reaches the screen.
 */
function ServerToolLine({ name, result }: { name: string; result?: string }) {
  const { label, detail } = readToolName(name);
  /*
   * A refusal is not a result, and must not read like one.
   *
   * The server says which it is rather than the browser inferring it from the wording, because the
   * wording is a policy message an administrator can rewrite and the first rephrasing would break
   * any guess made here. See REFUSAL_MARKER in server/src/plugins/tools.ts.
   */
  const answer = result === undefined ? undefined : asText(result);
  const refused = answer?.startsWith(REFUSAL_MARKER) ?? false;
  /*
   * The marker is for this component, not for the reader. Left in, a refusal reads "Blocked" in the
   * label and then "Refused." again in the first two words of the body, which is the same fact three
   * times over by the end of the sentence. Stripped here rather than on the server, because the
   * server's copy is what the model is told and "Refused." in front of a reason is right for it.
   */
  const body = refused ? answer?.slice(REFUSAL_MARKER.length).trim() : answer;
  return (
    <ToolLine
      {...(detail ? { detail } : {})}
      label={label}
      refused={refused}
      running={result === undefined}
    >
      {body ? (
        <Streamdown
          components={markdownComponents}
          urlTransform={markdownUrlTransform}
        >
          {forDisplay(body)}
        </Streamdown>
      ) : null}
    </ToolLine>
  );
}

function activityActionLabel(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) return "действие";
  if (
    count % 10 >= 2 &&
    count % 10 <= 4 &&
    (count % 100 < 10 || count % 100 >= 20)
  ) {
    return "действия";
  }
  return "действий";
}

/** A quiet activity summary keeps tool noise secondary to the answer while retaining full detail. */
function ActivitySummary({
  busy,
  snapshot,
}: {
  busy: boolean;
  snapshot: ActivitySnapshot;
}) {
  const duration =
    snapshot.elapsedMs > 0 ? ` · ${formatElapsedMs(snapshot.elapsedMs)}` : "";
  return (
    <details
      className="group/activity rounded-xl border border-border/60 bg-muted/15 px-3"
      data-testid="transcript-activity"
      open={busy}
    >
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-lg py-2 text-muted-foreground text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${busy ? "animate-pulse bg-primary motion-reduce:animate-none" : snapshot.status === "stopped" ? "bg-destructive" : "bg-muted-foreground/60"}`}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="[overflow-wrap:anywhere]">{snapshot.label}</span>
          <span className="text-xs">
            {snapshot.toolCount} {activityActionLabel(snapshot.toolCount)}
            {duration}
          </span>
        </span>
        <IconChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open/activity:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      {snapshot.steps.length > 0 ? (
        <ol className="mb-3 ml-0.5 flex flex-col gap-2 border-border border-l pl-3 text-muted-foreground text-xs leading-relaxed">
          {snapshot.steps.map((step) => (
            <li className="flex items-center gap-2" key={step.id}>
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${step.state === "active" ? "bg-primary" : step.state === "warning" ? "bg-destructive" : "bg-muted-foreground/40"}`}
              />
              <span>{step.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}

export function ChatTranscript({
  busy = false,
  hasOlder = false,
  loadingOlder = false,
  channelId,
  commandNames = "",
  conversationKey,
  messages,
  onLoadOlder,
  onRowRender,
  onRemoveQueued,
  queued = EMPTY_QUEUE,
  recoverArtifacts = false,
  restoring = false,
  run,
  stopped,
  onRetry,
}: ChatTranscriptProps) {
  const artifactChannelId = channelId ?? conversationKey;
  const [artifactIndex, setArtifactIndex] = useState<{
    channelId: string;
    items: readonly ArtifactMetadata[];
  }>({ channelId: "", items: [] });
  useEffect(() => {
    if (!recoverArtifacts || !artifactChannelId || restoring || busy) return;
    const controller = new AbortController();
    void listChannelArtifacts(artifactChannelId, controller.signal)
      .then((items) => {
        setArtifactIndex({ channelId: artifactChannelId, items });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setArtifactIndex({ channelId: artifactChannelId, items: [] });
        }
      });
    return () => controller.abort();
  }, [artifactChannelId, busy, recoverArtifacts, restoring]);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindowState>(() => {
    const saved = conversationKey
      ? conversationStateCache.get(conversationKey)
      : null;
    return {
      startId: saved?.historyStartId ?? null,
      size: saved?.historyWindowSize ?? TRANSCRIPT_HISTORY_PAGE_SIZE,
    };
  });
  /*
   * NOT MEMOISED, AND THAT IS DELIBERATE. The agent can mutate the same `messages` array while a
   * streamed answer arrives, so an identity-keyed memo can freeze the transcript. The projection
   * walks from the durable tail and only returns the mounted window; expensive markdown/tool rows
   * below remain memoised on primitive props.
   */
  const visible = projectTranscriptWindow(messages, {
    size: historyWindow.size,
    startId: historyWindow.startId,
    olderStep: TRANSCRIPT_HISTORY_PAGE_SIZE,
  });
  // The bounded projection is fresh on every render, so memoising on its array never skips work.
  const activity = activitySnapshotFor(visible.items, busy, stopped, run);
  const visibleArtifactIds = new Set(
    visible.items.flatMap((item) => {
      if (item.kind !== "tool") return [];
      const artifact = parseArtifactToolResult(
        item.toolCall.function.name,
        item.result,
      );
      return artifact ? [artifact.artifact.attachmentId] : [];
    }),
  );
  const recoveredArtifacts =
    historyWindow.startId === null &&
    artifactIndex.channelId === artifactChannelId
      ? artifactIndex.items.filter((item) => !visibleArtifactIds.has(item.id))
      : [];
  const viewportRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  const revealAnchor = useRef<{
    element: HTMLElement;
    top: number;
    scrollTop: number;
  } | null>(null);
  const scrollToLiveTail = useRef(false);
  const scrollToLiveTailBehavior = useRef<ScrollBehavior>("auto");
  const transcriptPainted = useRef(false);
  const seenRowIds = useRef(new Set<string>());
  const suppressNextEntrance = useRef(false);
  const previousUserMessageId = useRef<string | null>(null);

  // The scroller's own initial-position layout effect runs in the provider above this component.
  // Restore in a passive effect so its default "end" position cannot overwrite a saved channel
  // position during a route switch.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (
      !viewport ||
      restoredScroll.current ||
      restoring ||
      visible.items.length === 0 ||
      !conversationKey
    )
      return;
    const saved = conversationStateCache.get(conversationKey);
    if (saved.scrollTop !== null) {
      viewport.scrollTop =
        saved.distanceFromEnd !== null && saved.distanceFromEnd <= 2
          ? Math.max(0, viewport.scrollHeight - viewport.clientHeight)
          : Math.min(
              saved.scrollTop,
              Math.max(0, viewport.scrollHeight - viewport.clientHeight),
            );
    }
    restoredScroll.current = true;
  }, [conversationKey, restoring, visible.items.length]);

  // This effect is driven by window/row transitions held in refs; the explicit scalar dependencies
  // make prepend and return-to-tail corrections run after their DOM commit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll correction intentionally reruns after bounded window changes.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && scrollToLiveTail.current) {
      const target = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTo({
        behavior: scrollToLiveTailBehavior.current,
        top: target,
      });
      scrollToLiveTail.current = false;
      revealAnchor.current = null;
      if (conversationKey) {
        conversationStateCache.setScroll(conversationKey, {
          scrollTop: target,
          distanceFromEnd: 0,
        });
      }
      return;
    }

    const anchor = revealAnchor.current;
    if (!viewport || !anchor) return;
    if (anchor.element.isConnected) {
      viewport.scrollTop = anchoredScrollTop(
        anchor.scrollTop,
        anchor.top,
        anchor.element.getBoundingClientRect().top,
      );
    }
    revealAnchor.current = null;
  }, [
    conversationKey,
    historyWindow.size,
    historyWindow.startId,
    visible.items.length,
  ]);

  const rememberHistoryWindow = useCallback(
    (next: HistoryWindowState) => {
      if (conversationKey) {
        conversationStateCache.setHistoryWindow(conversationKey, next);
      }
      setHistoryWindow(next);
    },
    [conversationKey],
  );

  const rememberVisibleAnchor = () => {
    const viewport = viewportRef.current;
    const element = viewport?.querySelector<HTMLElement>(
      "[data-transcript-window-row]",
    );
    if (viewport && element) {
      revealAnchor.current = {
        element,
        top: element.getBoundingClientRect().top,
        scrollTop: viewport.scrollTop,
      };
    }
  };

  const revealOlder = () => {
    rememberVisibleAnchor();

    if (visible.olderStartId) {
      rememberHistoryWindow({
        startId: visible.olderStartId,
        size: Math.min(
          TRANSCRIPT_HISTORY_WINDOW_MAX,
          historyWindow.size + TRANSCRIPT_HISTORY_PAGE_SIZE,
        ),
      });
      return;
    }

    if (!hasOlder || !onLoadOlder || loadingOlder) return;
    void onLoadOlder().then((page) => {
      if (!page || page.messages.length === 0) return;
      const firstId = page.messages[0]?.id;
      if (!firstId) return;
      rememberHistoryWindow({
        startId: firstId,
        size: Math.min(
          TRANSCRIPT_HISTORY_WINDOW_MAX,
          historyWindow.size + page.messages.length,
        ),
      });
    });
  };

  const returnToLatest = useCallback(() => {
    scrollToLiveTail.current = true;
    scrollToLiveTailBehavior.current = prefersReducedMotion()
      ? "auto"
      : "smooth";
    suppressNextEntrance.current = true;
    rememberHistoryWindow({
      startId: null,
      size: TRANSCRIPT_HISTORY_PAGE_SIZE,
    });
  }, [rememberHistoryWindow]);

  const latestUserMessageId =
    messages.findLast((message) => message.role === "user")?.id ?? null;

  useEffect(() => {
    if (latestUserMessageId === null) return;
    if (previousUserMessageId.current === null) {
      previousUserMessageId.current = latestUserMessageId;
      return;
    }
    if (previousUserMessageId.current === latestUserMessageId) return;
    previousUserMessageId.current = latestUserMessageId;

    const viewport = viewportRef.current;
    if (!viewport) return;
    if (visible.hiddenAfter > 0) {
      returnToLatest();
      return;
    }
    viewport.scrollTo({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      top: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    });
  }, [latestUserMessageId, returnToLatest, visible.hiddenAfter]);

  const rowIsArriving = (id: string): boolean => {
    if (!transcriptPainted.current) return false;
    const canAnimate =
      historyWindow.startId === null &&
      visible.hiddenAfter === 0 &&
      !suppressNextEntrance.current;
    if (!canAnimate) {
      return false;
    }
    return !seenRowIds.current.has(id);
  };

  // Mark only committed rows as seen. Mutating this set during render would make an abandoned
  // concurrent render suppress the entrance animation of a row that never reached the screen.
  useEffect(() => {
    for (const item of visible.items) seenRowIds.current.add(item.id);
  }, [visible.items]);

  // Reset after the history window commits, so rows revealed from history never animate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: window transitions intentionally reset a render-only ref.
  useEffect(() => {
    transcriptPainted.current = true;
    suppressNextEntrance.current = false;
  }, [historyWindow.size, historyWindow.startId]);

  const persistScroll = useCallback(
    (snapshot: { scrollTop: number; distanceFromEnd: number }) => {
      if (!conversationKey) return;
      conversationStateCache.setScroll(conversationKey, snapshot);
    },
    [conversationKey],
  );

  const persistScrollRef = useRef(persistScroll);
  persistScrollRef.current = persistScroll;
  const pendingScrollSnapshot = useRef<{
    scrollTop: number;
    distanceFromEnd: number;
  } | null>(null);
  const scrollSchedulerRef = useRef<StreamTextScheduler | null>(null);
  if (scrollSchedulerRef.current === null) {
    scrollSchedulerRef.current = new StreamTextScheduler(() => {
      const snapshot = pendingScrollSnapshot.current;
      if (!snapshot) return;
      pendingScrollSnapshot.current = null;
      persistScrollRef.current(snapshot);
    });
  }
  const scrollScheduler = scrollSchedulerRef.current;
  useEffect(
    () => () => {
      // A route switch is a real boundary, not a reason to lose the last wheel/touch position.
      // Commit that final snapshot before cancelling the timer for the unmounted transcript.
      scrollScheduler.flush();
      scrollScheduler.cancelPending();
    },
    [scrollScheduler],
  );

  const schedulePersistScroll = (viewport: HTMLElement) => {
    if (!conversationKey) return;
    // The latest scroll snapshot is enough; avoid touching the cache for every wheel event.
    pendingScrollSnapshot.current = {
      scrollTop: viewport.scrollTop,
      distanceFromEnd: Math.max(
        0,
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ),
    };
    scrollScheduler.push(
      `${viewport.scrollTop}:${viewport.scrollHeight}:${viewport.clientHeight}`,
    );
  };

  return (
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={80}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport
            onScroll={(event) => {
              schedulePersistScroll(event.currentTarget);
            }}
            aria-label="История диалога"
            ref={viewportRef}
            preserveScrollOnPrepend
          >
            <MessageScrollerContent
              aria-busy={busy}
              className="mx-auto w-full max-w-3xl gap-6 px-3 py-4 sm:gap-7 sm:px-4 sm:py-6"
            >
              {/*
               * The memo boundary is INSIDE the scroller item, not around it. `MessageScrollerItem`
               * reads the scroller's context, so it re-renders whenever the scroll state moves and
               * memoising it would achieve nothing. Its child is what costs — markdown parsing and
               * chart SVGs — and that is what is skipped.
               */}
              {/* Instead of the rows, never alongside them: one real message and this is a lie. */}
              {visible.items.length === 0 && restoring ? (
                <RestoringTranscript />
              ) : null}
              {visible.hiddenBefore > 0 || hasOlder ? (
                <div className="flex justify-center pb-6">
                  <button
                    aria-busy={loadingOlder}
                    className="rounded-full border border-border bg-background px-4 py-2 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-60"
                    disabled={loadingOlder}
                    onClick={revealOlder}
                    type="button"
                  >
                    {loadingOlder
                      ? "Загрузка предыдущих сообщений…"
                      : visible.hiddenBefore > 0
                        ? `Показать предыдущие сообщения (${visible.hiddenBefore})`
                        : "Загрузить предыдущие сообщения"}
                  </button>
                </div>
              ) : null}
              {visible.items.map((item, index) =>
                item.kind === "tool" ? (
                  <MessageScrollerItem
                    data-transcript-window-row=""
                    key={item.id}
                    messageId={item.id}
                  >
                    <TranscriptToolCall
                      args={item.toolCall.function.arguments}
                      {...(artifactChannelId
                        ? { channelId: artifactChannelId }
                        : {})}
                      id={item.id}
                      arriving={rowIsArriving(item.id)}
                      live={
                        busy &&
                        visible.hiddenAfter === 0 &&
                        index === visible.items.length - 1 &&
                        item.result === undefined
                      }
                      name={item.toolCall.function.name}
                      onRender={onRowRender}
                      result={item.result}
                      toolCallId={item.toolCall.id}
                    />
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem
                    data-transcript-window-row=""
                    key={item.id}
                    messageId={item.id}
                  >
                    <TranscriptMessage
                      attachmentsJson={
                        item.attachments
                          ? JSON.stringify(item.attachments)
                          : EMPTY_ATTACHMENTS_JSON
                      }
                      {...(conversationKey
                        ? { channelId: conversationKey }
                        : {})}
                      commandNames={commandNames}
                      id={item.id}
                      onRender={onRowRender}
                      role={item.role}
                      streaming={
                        busy &&
                        visible.hiddenAfter === 0 &&
                        item.role === "assistant" &&
                        index === visible.items.length - 1
                      }
                      text={item.text}
                      arriving={rowIsArriving(item.id)}
                    />
                  </MessageScrollerItem>
                ),
              )}
              {recoveredArtifacts.length > 0 ? (
                <>
                  <p className="pt-1 text-muted-foreground text-xs">
                    Файлы этой переписки
                  </p>
                  {recoveredArtifacts.map((artifact) => (
                    <MessageScrollerItem
                      data-transcript-window-row=""
                      key={`recovered-artifact:${artifact.id}`}
                      messageId={`recovered-artifact:${artifact.id}`}
                    >
                      <MessageLayout>
                        <ArtifactCard
                          artifact={{
                            attachmentId: artifact.id,
                            filename: artifact.filename,
                            mimeType: artifact.mimeType,
                            size: artifact.size,
                            title: artifact.filename,
                          }}
                          channelId={artifactIndex.channelId}
                          toolCallId={`recovered-artifact:${artifact.id}`}
                        />
                      </MessageLayout>
                    </MessageScrollerItem>
                  ))}
                </>
              ) : null}
              {visible.hiddenAfter > 0 ? (
                <div className="flex justify-center py-2">
                  <button
                    className="rounded-full border border-border bg-background px-4 py-2 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={returnToLatest}
                    type="button"
                  >
                    Вернуться к последним сообщениям ({visible.hiddenAfter})
                  </button>
                </div>
              ) : null}
              {activity.toolCount > 0 ? (
                <ActivitySummary busy={busy} snapshot={activity} />
              ) : null}
              {busy && activity.toolCount === 0 ? (
                <p
                  className="flex min-h-16 items-center gap-2 text-muted-foreground text-sm leading-relaxed"
                  data-testid="transcript-run-status"
                  role="status"
                >
                  <span
                    className="shrink-0"
                    data-testid="transcript-thinking-orb"
                  >
                    <ThinkingOrb state="listening" size={64} />
                  </span>
                  {activity.label}
                </p>
              ) : null}
              {/*
               * Outside the item list, so neither of these is a message. Each has no id, is never
               * anchored, and is gone by the next turn — giving one a `MessageScrollerItem` would ask
               * the scroller to measure and anchor something that exists for a second and a half.
               *
               * One or the other, never both: a turn that ended has stopped being in flight, and a
               * animated activity under a line saying the Bot stopped would contradict it.
               */}
              {stopped ? <Stopped onRetry={onRetry} reason={stopped} /> : null}
              {/*
               * Below the thinking line, and outside the item list for the same reason it is: these
               * are not yet turns. They have ids of their own, but they are this tab's ids and not the
               * thread's, so handing them to the scroller would ask it to anchor on something that is
               * about to be replaced by a message with a different id — and the replacement is the
               * one worth scrolling to.
               */}
              {queued.map((message) => (
                <Queued
                  key={message.id}
                  onRemove={
                    onRemoveQueued
                      ? () => onRemoveQueued(message.id)
                      : undefined
                  }
                  text={message.text}
                />
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton
            aria-label={`Перейти к последним сообщениям${visible.hiddenAfter > 0 ? `: ${visible.hiddenAfter} новых` : ""}`}
            onClick={(event) => {
              event.preventDefault();
              returnToLatest();
            }}
          />
          <ScrollNewestQueuedIntoView newest={queued.at(-1)?.id ?? null} />
        </MessageScroller>
      </div>
    </MessageScrollerProvider>
  );
}
