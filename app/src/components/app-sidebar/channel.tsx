import {
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { memo, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  runMetadataPrefetch,
  scheduleChannelPrefetch,
} from "@/lib/channels/channel-prefetch";
import {
  deleteChannelMutationOptions,
  setChannelPinnedMutationOptions,
} from "@/lib/channels/mutations";
import { channelKeys, channelQueryOptions } from "@/lib/channels/queries";
import { useAgentRunActivity } from "@/lib/copilot/run-activity-store";
import { agentRunStatusLabel, isAgentRunActive } from "@/lib/copilot/run-state";
import {
  clearThreadMessagesCache,
  prefetchThreadMessages,
} from "@/lib/copilot/thread-messages";
import {
  beginChannelTiming,
  shouldBeginChannelTiming,
} from "@/lib/performance/workspace-timing";

/**
 * Memoized roster row. `use-channel-events` preserves unchanged row identity, and
 * `content-visibility` keeps off-screen rows cheap without virtualization.
 *
 * Right-click opens Pin and Delete. Deleting is confirmed in a dialog that names the channel,
 * because the row it was invoked on is one of several identical-looking rows.
 */
export const Channel = memo(function Channel({
  channelId,
  participantIds,
  name,
  lastMessage,
  lastMessageAt,
  historyScope,
  pinned,
  threadId,
  unread,
}: {
  channelId: string;
  participantIds: string[];
  name: string;
  lastMessage?: string;
  lastMessageAt?: string;
  historyScope?: string;
  pinned: boolean;
  threadId: string;
  unread: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Whether this row's channel is the one on screen, as a boolean, so navigating between
  // channels re-renders the two rows whose answer changed rather than the whole roster.
  const isOpen = useParams({
    strict: false,
    select: (params) =>
      (params as { channelId?: string }).channelId === channelId,
  });
  const setPinned = useMutation(setChannelPinnedMutationOptions(queryClient));
  const deleteChannel = useMutation(deleteChannelMutationOptions(queryClient));
  const [confirming, setConfirming] = useState(false);
  /**
   * Why a pin did not take, said on the row it was asked of.
   *
   * Pinning used to fail in total silence: the menu closed, the pin did not move, and nothing on
   * screen accounted for it — which reads as the app ignoring the click. There is no toast in this
   * app, and the row is where the person was looking, so the sentence goes here and is replaced by
   * the next attempt.
   */
  const [pinProblem, setPinProblem] = useState<string | null>(null);
  const runtimeAgentId = participantIds[0] ?? "";
  const runActivity = useAgentRunActivity({
    channelId,
    agentId: runtimeAgentId,
  });
  const isWorking =
    runActivity !== null && isAgentRunActive(runActivity.state.status);

  const prefetchChannel = () => {
    // A global speculative queue may outlive a sign-in transition. Without an authenticated scope
    // it must not deduplicate or warm metadata on behalf of an unknown session.
    if (!historyScope) return;
    scheduleChannelPrefetch({
      agentId: runtimeAgentId,
      channelId,
      sessionScope: historyScope,
      threadId,
      onScopeChange: (previousScope) => {
        // Channel query keys predate authenticated scoping, so they must be destroyed before a new
        // user's first hover can reuse them. The scheduler has already aborted the old callbacks.
        void queryClient.cancelQueries({ queryKey: channelKeys.all });
        queryClient.removeQueries({ queryKey: channelKeys.all });
        clearThreadMessagesCache(previousScope);
      },
      prefetchMetadata: (signal) => {
        const options = channelQueryOptions(channelId);
        return runMetadataPrefetch({
          signal,
          queryClient,
          queryKey: options.queryKey,
          prefetch: () => queryClient.prefetchQuery(options),
        });
      },
      ...(runtimeAgentId
        ? {
            prefetchHistory: (signal: AbortSignal) =>
              prefetchThreadMessages(historyScope, threadId, runtimeAgentId, {
                signal,
              }),
          }
        : {}),
    });
  };

  const confirmDelete = async () => {
    /*
     * Away first when this row's channel is the one on screen.
     *
     * The roster invalidates the moment the delete lands, so this row — and the dialog living inside
     * it — unmounts while the rest of this function is still owed. Navigating after the mutation
     * therefore ran in a component that was already gone, leaving somebody looking at a conversation
     * that no longer exists. Leaving before asking is safe in the other direction: a refused delete
     * puts them on the roster with the channel still in it, and says why in the dialog.
     */
    if (isOpen) {
      await navigate({ to: "/" });
    }
    try {
      await deleteChannel.mutateAsync(channelId);
    } catch {
      // The error is on the mutation and rendered in the dialog; leaving it open says "not done".
      return;
    }
    setConfirming(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger>
          <Link
            to="/channel/$channelId"
            params={{ channelId }}
            type="button"
            className="group flex min-h-16 w-full flex-row items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-sidebar-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring [contain-intrinsic-size:auto_4rem] [content-visibility:auto]"
            activeProps={{
              className:
                "bg-sidebar-accent/80 ring-1 ring-inset ring-sidebar-border/70",
            }}
            onFocus={prefetchChannel}
            onMouseEnter={prefetchChannel}
            onClick={(event) => {
              if (!shouldBeginChannelTiming(isOpen, event)) return;
              beginChannelTiming(channelId);
            }}
          >
            <div className="shrink-0">
              <ChannelAvatar participantIds={participantIds} size={32} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 flex-row items-center gap-2">
                <span
                  className={`min-w-0 flex-1 truncate text-sm tracking-tight ${
                    unread ? "font-medium" : ""
                  }`}
                >
                  {name}
                </span>
                <div className="shrink-0 whitespace-nowrap text-right text-[11px] leading-4 text-muted-foreground/70">
                  {lastMessageAt}
                </div>
              </div>
              <div className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">
                  {isWorking
                    ? agentRunStatusLabel(runActivity.state.status)
                    : lastMessage}
                </span>
                {isWorking ? (
                  <span
                    aria-label="Сотрудник работает"
                    className="flex shrink-0 items-center gap-1 text-[11px] text-primary"
                    role="status"
                  >
                    <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                    работает
                  </span>
                ) : unread ? (
                  /* State about the message beats state about the row, so it sits first. */
                  <span className="size-2 shrink-0 rounded-full bg-primary" />
                ) : null}
                {pinned ? (
                  <IconPinFilled className="size-3 shrink-0 text-muted-foreground/70" />
                ) : null}
              </div>
            </div>
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => {
              setPinProblem(null);
              setPinned.mutate(
                { channelId, pinned: !pinned },
                { onError: (thrown) => setPinProblem(thrown.message) },
              );
            }}
          >
            {pinned ? <IconPinnedOff /> : <IconPin />}
            {pinned ? "Unpin channel" : "Pin channel"}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => {
              // A refusal from a previous attempt is not news about this one.
              deleteChannel.reset();
              setConfirming(true);
            }}
          >
            <IconTrash />
            Delete channel…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {pinProblem ? (
        <p className="px-2 pb-1 text-destructive text-xs" role="alert">
          {pinProblem}
        </p>
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        open={confirming}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              The conversation will no longer appear for anyone in it.
            </DialogDescription>
          </DialogHeader>
          {deleteChannel.error ? (
            <p className="text-destructive text-sm">
              {deleteChannel.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteChannel.isPending}
              onClick={() => {
                void confirmDelete();
              }}
              size="sm"
              variant="destructive"
            >
              {deleteChannel.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
