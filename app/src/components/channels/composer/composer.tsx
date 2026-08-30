import {
  IconArrowUp,
  IconAt,
  IconBolt,
  IconPaperclip,
  IconPlayerStopFilled,
  IconPlus,
} from "@tabler/icons-react";
import { PromptArea, type PromptAreaHandle } from "prompt-area";
import type { Segment } from "prompt-area/helpers";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  deleteAttachment,
  type UploadedAttachment,
} from "@/lib/attachments/api";
import { conversationStateCache } from "@/lib/channels/conversation-state";
import { cn } from "@/lib/utils";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  ATTACHMENT_ACCEPT,
  type AttachmentDraftItem,
  type AttachmentSubmission,
  addAttachmentFiles,
  attachmentDraftReducer,
  releaseAttachmentPreviews,
  uploadAttachmentDraft,
} from "./attachment-draft";
import { AttachmentTray } from "./attachment-tray";
import {
  AGENT_TRIGGER,
  appendTrigger,
  applyCommandChips,
  COMMAND_TRIGGER,
  type CommandOption,
  type ComposerDraft,
  enforceSingleAgent,
  toDraft,
} from "./draft";
import { PLACEHOLDER_COMMANDS } from "./sources";
import { type AgentOption, buildTriggers } from "./triggers";

const MAX_HEIGHT_PX = 220;
/**
 * Tracks the compact `text-sm` line box so PromptArea stays vertically centered in one row.
 */
const COMPACT_MIN_HEIGHT_PX = 19;
const COMPACT_MAX_HEIGHT_PX = 96;
const DRAFT_CLEANUP_DEADLINE_MS = 2_000;

export type ComposerProps = {
  className?: string;
  compact?: boolean;
  /** Bounded in-memory draft key used when a channel route is remounted. */
  conversationKey?: string;
  /** Agents that `@` can address. Empty means the mention menu reports an empty channel. */
  agents?: readonly AgentOption[];
  commands?: readonly CommandOption[];
  /**
   * Receives the whole draft rather than a string, so a mention or a command reaches the caller as
   * structured data instead of something it would have to re-parse out of the text.
   */
  onSubmit?: (
    draft: ComposerDraft,
    attachments: AttachmentSubmission,
  ) => void | Promise<void>;
  /** Test seam for the multipart boundary; production uses the attachment API client. */
  attachmentUploader?: (
    channelId: string,
    file: File,
    signal?: AbortSignal,
  ) => Promise<UploadedAttachment>;
  /**
   * Park this message until the turn in flight is over, instead of refusing the keystroke.
   *
   * Its presence is what lets a person type at a Bot that is already working. Without it the
   * composer goes on refusing mid-turn sends, which is still the right answer for a screen that has
   * nowhere to put a parked message — the compose screen creates the channel on send and then
   * navigates away, so anything parked there would be dropped on unmount, and a message that
   * silently disappears is worse than a send button that visibly will not go.
   *
   * Called instead of `onSubmit`, not as well as it, and it does not return a promise: parking is
   * a state change, and awaiting one would hold the composer's send lock for the length of somebody
   * else's turn and block the next correction.
   */
  onQueue?: (draft: ComposerDraft) => void;
  /** Stop the Bot mid-answer; while pending, the send button becomes a stop button. */
  onStop?: () => void;
  /**
   * The conversation cannot take another message at all, which is a property of the conversation
   * rather than of the moment: a channel whose coworker was deleted. This is the only thing that
   * stops a person typing.
   */
  disabled?: boolean;
  /**
   * A turn is in flight. It gates sending, not writing: a channel is `pending` while it is still
   * connecting and restoring its history, and the composer is on screen throughout.
   */
  pending?: boolean;
  /**
   * Put the caret in the editor the first moment it can take one, and then leave it alone. For the
   * screens where typing is the next thing a person does — choosing a coworker answers the "to"
   * field, and the message is what remains.
   *
   * Once, not on every change: it used to re-claim the caret whenever the editor became interactive
   * again, so a person who had clicked into something else — a search box, another channel's row —
   * had the cursor yanked back the moment a turn finished. A send of their own still returns the
   * caret, because that one they asked for.
   */
  autoFocus?: boolean;
  /**
   * There is a run on the wire for Stop to reach.
   *
   * Not the same question as `pending`, and telling them apart is the whole reason this exists. A
   * turn is in flight from the moment somebody presses send; the run it becomes does not exist
   * until the caller has waited for whatever it has to wait for, which on a channel that is still
   * joining is up to a second and a half. A Stop button drawn in that window aborts a controller
   * nobody has made yet: the press is swallowed, the message goes anyway, and the one control the
   * whole affordance leans on has quietly lied.
   *
   * Defaults to `pending`, which is the right answer for a caller with no gap between the two.
   */
  stoppable?: boolean;
};

export function Composer({
  className,
  compact = false,
  conversationKey,
  agents = [],
  commands = PLACEHOLDER_COMMANDS,
  onSubmit,
  attachmentUploader,
  onQueue,
  onStop,
  disabled = false,
  pending = false,
  autoFocus = false,
  stoppable,
}: ComposerProps) {
  const [value, setValueState] = useState<Segment[]>(() =>
    conversationKey ? conversationStateCache.get(conversationKey).draft : [],
  );
  const setValue = useCallback(
    (next: SetStateAction<Segment[]>) => {
      setValueState((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        if (conversationKey) {
          conversationStateCache.setDraft(conversationKey, resolved);
        }
        return resolved;
      });
    },
    [conversationKey],
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachmentItems, dispatchAttachments] = useReducer(
    attachmentDraftReducer,
    [],
  );
  const attachmentItemsRef = useRef<readonly AttachmentDraftItem[]>([]);
  attachmentItemsRef.current = attachmentItems;
  const previewUrlsRef = useRef(new Set<string>());
  const submitControllersRef = useRef(new Set<AbortController>());
  const committedAttachmentIdsRef = useRef(new Set<string>());
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submitInFlight = useRef(false);
  const promptAreaRef = useRef<PromptAreaHandle>(null);
  /** A send has completed and the caret is owed back, as soon as the editor will take it. */
  const wantsFocus = useRef(false);
  /** `autoFocus` has been honoured once, and is not owed again for the life of this composer. */
  const claimedAutoFocus = useRef(false);

  const isBusy = pending || isSubmitting;
  const triggers = useMemo(
    () => buildTriggers({ agents, commands }),
    [agents, commands],
  );
  const draft = useMemo(() => toDraft(value), [value]);
  const hasAttachments = attachmentItems.length > 0;
  const attachmentBlocked = attachmentItems.some(
    (item) => item.status === "failed" || item.status === "uploading",
  );

  useEffect(() => {
    const liveIds = new Set(attachmentItems.map((item) => item.localId));
    for (const localId of committedAttachmentIdsRef.current) {
      if (!liveIds.has(localId))
        committedAttachmentIdsRef.current.delete(localId);
    }
  }, [attachmentItems]);

  useEffect(
    () => () => {
      for (const controller of submitControllersRef.current) {
        controller.abort();
      }
      submitControllersRef.current.clear();
      for (const item of attachmentItemsRef.current) {
        if (
          committedAttachmentIdsRef.current.has(item.localId) ||
          !item.attachment ||
          !item.uploadedChannelId
        ) {
          continue;
        }
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          DRAFT_CLEANUP_DEADLINE_MS,
        );
        void deleteAttachment(
          item.uploadedChannelId,
          item.attachment.id,
          controller.signal,
        )
          .catch(() => undefined)
          .finally(() => clearTimeout(timeout));
      }
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current.clear();
    },
    [],
  );

  const releasePreviews = useCallback(
    (items: readonly AttachmentDraftItem[]) => {
      releaseAttachmentPreviews(items, (url) => {
        if (!previewUrlsRef.current.delete(url)) return;
        URL.revokeObjectURL(url);
      });
    },
    [],
  );

  const addFiles = useCallback(
    (files: FileList | readonly File[]) => {
      if (disabled || isBusy || submitInFlight.current || files.length === 0)
        return;
      const result = addAttachmentFiles(attachmentItemsRef.current, [...files]);
      for (const item of result.items) {
        if (item.previewUrl) previewUrlsRef.current.add(item.previewUrl);
      }
      dispatchAttachments({ type: "replace", items: result.items });
      setAttachmentError(
        result.rejected.length > 0
          ? `Не удалось добавить: ${result.rejected.join(", ")}. Проверьте формат или лимит в 10 файлов.`
          : null,
      );
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [disabled, isBusy],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      if (submitInFlight.current) return;
      const item = attachmentItemsRef.current.find(
        (candidate) => candidate.localId === localId,
      );
      if (item) releasePreviews([item]);
      if (item?.attachment && item.uploadedChannelId) {
        void deleteAttachment(item.uploadedChannelId, item.attachment.id).catch(
          () => setAttachmentError("Не удалось удалить загруженный файл."),
        );
      }
      dispatchAttachments({ type: "remove", localId });
      setAttachmentError(null);
    },
    [releasePreviews],
  );

  const retryAttachment = useCallback((localId: string) => {
    if (submitInFlight.current) return;
    dispatchAttachments({ type: "retry", localId });
  }, []);

  const handleChange = useCallback(
    (next: Segment[]) => {
      const { segments, actions } = applyCommandChips(
        enforceSingleAgent(next),
        commands,
      );
      setValue(segments);
      // Run after the commit so an action that navigates or opens a panel is not fighting the
      // editor's own state update for the same tick.
      for (const action of actions) {
        action();
      }
    },
    [commands, setValue],
  );

  /**
   * The single submit path for Enter, the send button, and the form.
   *
   * `submitInFlight` is a ref rather than `isSubmitting` because a second Enter can land before
   * React has re-rendered with the new state, which would send the message twice.
   */
  const submitDraft = useCallback(
    async (segments: Segment[]) => {
      const textDraft = toDraft(segments);
      const submitted = {
        ...textDraft,
        isEmpty: textDraft.isEmpty && !hasAttachments,
      };
      if (submitted.isEmpty || disabled || attachmentBlocked) {
        return;
      }

      /*
       * A TURN IS IN FLIGHT, AND THIS IS THE FORK THE WHOLE AFFORDANCE HANGS ON.
       *
       * With somewhere to park it the message goes there and the box empties, so the person sees
       * their words land. Without, we are back to refusing, which is what every caller that does
       * not queue still gets.
       *
       * It returns before `submitInFlight` and `isSubmitting` are touched on purpose. Those guard
       * one send from starting twice; a send here is held open for the length of the whole run, so
       * borrowing them for a parked message would let the first turn lock out every correction
       * typed while it worked — the exact thing this exists to allow.
       */
      if (isBusy) {
        // File drafts stay local. Queueing them would retain browser File objects after this turn.
        if (hasAttachments) return;
        if (!onQueue) {
          return;
        }
        setValue([]);
        onQueue(submitted);
        return;
      }

      if (submitInFlight.current || !onSubmit) {
        return;
      }

      submitInFlight.current = true;
      setIsSubmitting(true);
      const submitController = new AbortController();
      submitControllersRef.current.add(submitController);
      // Clear optimistically; restore if the send fails before becoming a message.
      setValue([]);
      try {
        const filesForThisSubmit = attachmentItemsRef.current;
        let committed = false;
        const commit = () => {
          if (committed) return;
          committed = true;
          for (const item of filesForThisSubmit) {
            committedAttachmentIdsRef.current.add(item.localId);
          }
          releasePreviews(filesForThisSubmit);
          dispatchAttachments({ type: "reset" });
          setAttachmentError(null);
        };
        const attachmentSubmission: AttachmentSubmission = {
          count: filesForThisSubmit.length,
          commit,
          upload: (channelId) =>
            uploadAttachmentDraft({
              channelId,
              items: filesForThisSubmit,
              dispatch: dispatchAttachments,
              signal: submitController.signal,
              ...(attachmentUploader ? { upload: attachmentUploader } : {}),
            }),
        };
        await onSubmit(submitted, attachmentSubmission);
        commit();
      } catch (error) {
        setValue(segments);
        throw error;
      } finally {
        submitControllersRef.current.delete(submitController);
        submitInFlight.current = false;
        setIsSubmitting(false);
        // Asked for here, performed in the effect below, which runs after the commit that clears
        // `isSubmitting` and so after the render the caret would otherwise be placed against.
        wantsFocus.current = true;
      }
    },
    [
      attachmentBlocked,
      attachmentUploader,
      disabled,
      hasAttachments,
      isBusy,
      onQueue,
      onSubmit,
      releasePreviews,
      setValue,
    ],
  );

  /**
   * Put the caret back the moment the composer can accept it again.
   *
   * Keyed off the editor becoming interactive rather than off the send resolving, so it survives
   * whatever the parent does with `pending` in between — and it runs after the commit, which is the
   * only point at which the element is enabled and focusable.
   *
   * Two different debts, and only one of them recurs. A finished send owes the caret back every
   * time. `autoFocus` owes it exactly once, at the start: it used to be re-owed on every
   * disabled/busy transition, so every completed turn stole the caret back from wherever the person
   * had moved it, and a composer that had never been sent from would grab focus mid-conversation.
   */
  useEffect(() => {
    if (disabled || isBusy) {
      return;
    }
    const owed = wantsFocus.current || (autoFocus && !claimedAutoFocus.current);
    if (!owed) {
      return;
    }
    wantsFocus.current = false;
    claimedAutoFocus.current = true;
    promptAreaRef.current?.focus();
  }, [autoFocus, disabled, isBusy]);

  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft(value).catch(() => undefined);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.currentTarget.files) addFiles(event.currentTarget.files);
  };

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDraggingFiles(false);
    addFiles(event.dataTransfer.files);
  };

  const handlePaste = (event: ClipboardEvent<HTMLFormElement>) => {
    if (event.clipboardData.files.length === 0) return;
    event.preventDefault();
    addFiles(event.clipboardData.files);
  };

  /** Open the existing @ or / picker from the plus menu, then put the caret beside it. */
  const insertTrigger = useCallback(
    (trigger: typeof AGENT_TRIGGER | typeof COMMAND_TRIGGER) => {
      setValue((current) => appendTrigger(current, trigger));
      requestAnimationFrame(() => promptAreaRef.current?.focus());
    },
    [setValue],
  );

  /**
   * There is a turn in flight and somewhere to park what is being typed.
   *
   * Not the same question as "is anything typed" — an empty composer mid-turn can queue nothing,
   * and the button it wants is Stop.
   */
  const canQueue = Boolean(onQueue) && isBusy && !disabled && !hasAttachments;
  /** Something is typed, mid-turn, with a queue to put it in. */
  const parking = canQueue && !draft.isEmpty;
  const canSend =
    !disabled &&
    !attachmentBlocked &&
    (!draft.isEmpty || hasAttachments) &&
    (!isBusy || canQueue);
  /**
   * Stop is available only once there is a run for it to reach, and it gives way to Send the moment
   * there is something typed to park.
   *
   * `stoppable` rather than `pending`, because a turn is in flight before its run is, and a button
   * that cannot do the thing it names is worse than no button at all.
   *
   * One button, so one of the two has to yield. Send wins because the correction is the thing that
   * cannot wait: park it and the box empties, which brings Stop straight back — so stopping is
   * never more than one press away, and the press before it is the one that saves the sentence.
   * Showing both would be honest and would also put two round buttons in a row on a compact
   * composer that has room for one.
   */
  const canStop = Boolean(onStop) && (stoppable ?? pending) && !parking;
  /**
   * The same arrow either way, because it is the same gesture, but a screen reader is told which of
   * the two it is about to do. "Send" on a button that will not send for another minute is a small
   * lie told to exactly the people who cannot see the queue it lands in.
   */
  const sendLabel = parking
    ? "Поставить сообщение в очередь"
    : "Отправить сообщение";

  if (compact) {
    return (
      <div className={className}>
        <form
          aria-busy={isBusy}
          className="relative overflow-hidden rounded-2xl border border-border bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
          data-testid="composer-form"
          onDragEnter={(event) => {
            event.preventDefault();
            if (!disabled && !isBusy) setDraggingFiles(true);
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setDraggingFiles(false);
            }
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          onPaste={handlePaste}
          onSubmit={handleFormSubmit}
        >
          <input
            accept={ATTACHMENT_ACCEPT}
            aria-label="Добавить файлы"
            className="sr-only"
            disabled={disabled || isBusy}
            multiple
            onChange={handleFileInput}
            ref={fileInputRef}
            type="file"
          />
          <AttachmentTray
            disabled={isSubmitting}
            items={attachmentItems}
            onRemove={removeAttachment}
            onRetry={retryAttachment}
          />
          <div className="flex min-h-14 items-center gap-3 px-3 py-3">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label="Дополнительные действия"
                    disabled={disabled}
                    size="icon"
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <IconPlus className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" sideOffset={8}>
                <DropdownMenuItem
                  disabled={isBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <IconPaperclip />
                  Загрузить файл
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => insertTrigger(AGENT_TRIGGER)}>
                  <IconAt />
                  Упомянуть сотрудника
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => insertTrigger(COMMAND_TRIGGER)}
                >
                  <IconBolt />
                  Использовать навык
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <PromptArea
              aria-label="Сообщение"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm shadow-none"
              disabled={disabled}
              maxHeight={COMPACT_MAX_HEIGHT_PX}
              minHeight={COMPACT_MIN_HEIGHT_PX}
              onChange={handleChange}
              onSubmit={(segments) => {
                void submitDraft(segments).catch(() => undefined);
              }}
              placeholder="Напишите сообщение"
              ref={promptAreaRef}
              triggers={triggers}
              value={value}
            />
            {canStop ? (
              <Button
                aria-label="Остановить сотрудника"
                className="size-8 rounded-full p-0"
                data-testid="composer-stop"
                onClick={onStop}
                size="icon"
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label={sendLabel}
                className="size-8 rounded-full p-0"
                disabled={!canSend}
                size="icon"
                type="submit"
              >
                <IconArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
          {draggingFiles ? (
            <div
              className="absolute inset-0 flex items-center justify-center bg-card/95 text-sm"
              role="status"
            >
              Отпустите файлы здесь
            </div>
          ) : null}
        </form>
        {attachmentError ? (
          <p className="pt-2 text-destructive text-xs" role="alert">
            {attachmentError}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("w-xl", className)}>
      <form
        aria-busy={isBusy}
        className="relative overflow-hidden rounded-2xl border border-border bg-card"
        data-testid="composer-form"
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled && !isBusy) setDraggingFiles(true);
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDraggingFiles(false);
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onPaste={handlePaste}
        onSubmit={handleFormSubmit}
      >
        <input
          accept={ATTACHMENT_ACCEPT}
          aria-label="Добавить файлы"
          className="sr-only"
          disabled={disabled || isBusy}
          multiple
          onChange={handleFileInput}
          ref={fileInputRef}
          type="file"
        />
        <AttachmentTray
          disabled={isSubmitting}
          items={attachmentItems}
          onRemove={removeAttachment}
          onRetry={retryAttachment}
        />

        <div className="grow px-3 pt-3 pb-2">
          <PromptArea
            aria-label="Сообщение"
            autoGrow
            className="w-full border-0 bg-transparent p-0 text-sm shadow-none"
            disabled={disabled}
            maxHeight={MAX_HEIGHT_PX}
            onChange={handleChange}
            onSubmit={(segments) => {
              void submitDraft(segments).catch(() => undefined);
            }}
            placeholder="Напишите сообщение"
            ref={promptAreaRef}
            triggers={triggers}
            value={value}
          />
        </div>

        <div className="mb-2 flex items-center justify-between px-2">
          <Button
            aria-label="Добавить файлы"
            disabled={disabled || isBusy}
            onClick={() => fileInputRef.current?.click()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <IconPaperclip className="size-4" />
          </Button>

          <div>
            {canStop ? (
              <Button
                aria-label="Остановить сотрудника"
                className="size-7 rounded-full bg-primary p-0"
                data-testid="composer-stop"
                onClick={onStop}
                type="button"
              >
                <IconPlayerStopFilled className="size-3" />
              </Button>
            ) : (
              <Button
                aria-label={sendLabel}
                className="size-7 rounded-full bg-primary p-0 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canSend}
                type="submit"
              >
                <IconArrowUp className="size-3.5 fill-primary" />
              </Button>
            )}
          </div>
        </div>
        {draggingFiles ? (
          <div
            className="absolute inset-0 flex items-center justify-center bg-card/95 text-sm"
            role="status"
          >
            Отпустите файлы здесь
          </div>
        ) : null}
      </form>
      {attachmentError ? (
        <p className="pt-2 text-destructive text-xs" role="alert">
          {attachmentError}
        </p>
      ) : null}
    </div>
  );
}
