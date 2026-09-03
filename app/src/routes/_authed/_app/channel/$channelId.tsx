import { IconDeviceDesktop, IconSettings } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { AgentProfile } from "@/components/agents/agent-profile";
import { hasUnseenActivity } from "@/components/app-sidebar/app-sidebar";
import { ChannelAvatar } from "@/components/channels/avatar";
import { ChannelChat } from "@/components/channels/channel-chat";
import { ActivityLog } from "@/components/computer/activity-log";
import { ComputerView } from "@/components/computer/computer-view";
import { useNeedsYou } from "@/components/computer/needs-you";
import { DetailPanel } from "@/components/layout/detail-panel";
import { PageLoading } from "@/components/layout/page-loading";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { nextDisplayedChannel } from "@/lib/channels/displayed-channel";
import { markChannelReadMutationOptions } from "@/lib/channels/mutations";
import {
  type AgentChannel,
  channelListQueryOptions,
  channelQueryOptions,
} from "@/lib/channels/queries";
import { onComputerActivity } from "@/lib/copilot/computer-activity";
import { CopilotProvider } from "@/lib/copilot/provider";
import { useAgentRunActivity } from "@/lib/copilot/run-activity-store";
import { agentRunStatusLabel } from "@/lib/copilot/run-state";

const chatSearchSchema = z.object({
  settings: z.boolean().optional(),
  /** Opens the Bot's screen in the shared detail pane. */
  watch: z.boolean().optional(),
});

/** Shared detail pane width for the live screen view. */
const SCREEN_PANEL_WIDTH = 400;

export const Route = createFileRoute("/_authed/_app/channel/$channelId")({
  validateSearch: chatSearchSchema,
  component: RouteComponent,
});

/**
 * What the Bot is looking at, and what it is doing.
 *
 * Two surfaces, stacked rather than tabbed. The screen was the only window into a Bot's computer,
 * so a Bot that spent two minutes in a terminal showed a blank browser and nothing else: the honest
 * answer to "what is it doing" was "something, on a machine holding your logins". The activity —
 * the shell and the workspace — sits below the screen, so watching one never costs the other and
 * nothing about what the Bot is doing hides behind a tab nobody clicked.
 */
function ComputerViewPanel({
  agentId,
  name,
}: {
  agentId: string;
  name?: string;
}) {
  return (
    <div className="mt-4 px-4">
      <div className="p-4">
        <ComputerView active computerId={agentId} name={name} />

        <div className="mt-10">
          <h3 className="mb-2 font-medium text-sm">Действия</h3>
          <ActivityLog computerId={agentId} />
        </div>
      </div>
    </div>
  );
}

function RouteComponent() {
  const { channelId } = Route.useParams();
  const { settings, watch } = Route.useSearch();
  const channel = useQuery(channelQueryOptions(channelId));
  /**
   * Keep the previous conversation mounted while a new route's detail query is in flight. The
   * query can briefly have no data on every click; showing PageLoading there was the hard flash
   * people saw between otherwise instant sidebar selections.
   */
  const resolvedChannel =
    channel.data?.id === channelId ? channel.data : undefined;
  const [displayedChannel, setDisplayedChannel] = useState<
    AgentChannel | undefined
  >(() => resolvedChannel);
  useEffect(() => {
    setDisplayedChannel((current) =>
      nextDisplayedChannel(current, resolvedChannel, channelId),
    );
  }, [channelId, resolvedChannel]);
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const navigate = Route.useNavigate();
  const isSettingsOpen = settings === true;
  const isWatching = watch === true;
  /** Channel routing currently supports one coworker. */
  const agentId = displayedChannel?.agentIds[0];
  const isSwitching = displayedChannel?.id !== channelId;
  /** Only polled while the screen is closed; the screen panel polls control itself. */
  const needsYou = useNeedsYou(agentId, !isWatching);

  const queryClient = useQueryClient();
  const markRead = useMutation(markChannelReadMutationOptions(queryClient));
  /*
   * This channel's roster summary, read out of the same infinite query the sidebar renders.
   * The detail query deliberately knows nothing about activity; the roster is where the socket
   * keeps lastMessageAt live, so it is the one honest source for "has something new been said".
   */
  const roster = useInfiniteQuery(channelListQueryOptions());
  const summary = roster.data?.find((row) => row.id === channelId);

  /*
   * Opening the channel marks it read; the Bot replying while it is open marks it read again.
   * One effect covers both: the dep changes on navigation and on every activity patch, and the
   * unseen check keeps it from writing a row per render. No dependency on the mutation object —
   * its identity changes per render and the effect must not re-fire for that.
   *
   * Keyed on primitives, deliberately. The optimistic mark-read patch changes the summary OBJECT's
   * identity without changing these values, so an object dep would re-fire the effect on its own
   * write — and when lastMessageAt sits ahead of this browser's clock (another device wrote it),
   * that re-fire loops into a PUT per render. Primitives hold still under the patch: one PUT.
   */
  const unseen = summary !== undefined && hasUnseenActivity(summary);
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (unseen) {
      markReadMutate(channelId);
    }
  }, [channelId, unseen, markReadMutate]);

  /*
   * Needs-you prompts auto-open the screen panel, because the prompt with the reason on it — the
   * amber "the assistant needs you" row, and the masked field for a credential — is drawn on the
   * screen card in that panel. Nothing about a stuck Bot is actionable until this pane is open.
   */
  useEffect(() => {
    if (!needsYou) return;
    show("watch");
  });

  // Browser activity may auto-open the screen once per run unless this run was dismissed.
  const dismissedEpoch = useRef<number | null>(null);
  const runEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (!agentId) return;
    return onComputerActivity((activity) => {
      if (activity.botId !== agentId) return;
      runEpoch.current = activity.epoch;
      if (dismissedEpoch.current === activity.epoch) return;
      navigate({
        search: (previous) =>
          previous.watch === true || previous.settings === true
            ? previous
            : { ...previous, settings: undefined, watch: true },
      });
    });
  }, [agentId, navigate]);

  // Settings and watch share one pane; opening either clears the other URL flag.
  const show = (next: "settings" | "watch" | null) => {
    // Dismissal applies only to the current browser-activity run.
    if (next !== "watch" && isWatching)
      dismissedEpoch.current = runEpoch.current;
    return navigate({
      search: (previous) => ({
        ...previous,
        settings: next === "settings" ? true : undefined,
        watch: next === "watch" ? true : undefined,
      }),
    });
  };

  return (
    <DetailPanel
      onClose={() => show(null)}
      open={(isSettingsOpen || isWatching) && agentId !== undefined}
      detailWidth={isWatching ? SCREEN_PANEL_WIDTH : undefined}
      detail={
        agentId === undefined ? null : isWatching ? (
          // Manual watch remains active even when there is no current browser action.
          <ComputerViewPanel agentId={agentId} name={channel?.data?.name} />
        ) : (
          <AgentProfile agentId={agentId} />
        )
      }
    >
      <div className="flex flex-col">
        <div className="sticky top-0 flex h-12 flex-row items-center justify-between gap-2 border-border border-b px-3">
          {/* Keep navigation chrome stable while the keyed chat boundary changes below. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="shrink-0">
              <ChannelAvatar
                participantIds={displayedChannel?.agentIds ?? []}
                size={22}
              />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="min-w-0 text-sm tracking-tight truncate">
                {displayedChannel?.name ?? "Диалог"}
              </span>
              {agentId ? (
                <ChannelHeaderStatus
                  agentId={agentId}
                  channelAvailable={displayedChannel?.active ?? null}
                  channelId={displayedChannel?.id ?? channelId}
                  switching={isSwitching}
                />
              ) : null}
            </div>
          </div>
          <div className="flex flex-row gap-1.5">
            <Button
              aria-label={
                needsYou
                  ? "Сотрудник ждёт вашего действия. Открыть экран"
                  : "Наблюдать за экраном сотрудника"
              }
              aria-pressed={isWatching}
              className={`relative ${isWatching ? "bg-foreground/5" : ""}`}
              disabled={agentId === undefined}
              onClick={() => show(isWatching ? null : "watch")}
              variant="ghost"
              size="icon"
            >
              <IconDeviceDesktop className="size-4.5" />
              {/* Mirrors needs-you state outside the hidden screen pane. */}
              {needsYou ? (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-amber-500" />
              ) : null}
            </Button>
            <Button
              aria-label="Профиль сотрудника"
              aria-pressed={isSettingsOpen}
              className={isSettingsOpen ? "bg-foreground/5" : undefined}
              disabled={agentId === undefined}
              onClick={() => show(isSettingsOpen ? null : "settings")}
              variant="ghost"
              size="icon"
            >
              <IconSettings className="size-4.5" />
            </Button>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ChannelBody
          channel={displayedChannel}
          hasError={Boolean(channel.error && displayedChannel === undefined)}
          historyScope={currentUser?.id}
          isPending={channel.isPending && displayedChannel === undefined}
        />
      </div>
    </DetailPanel>
  );
}

function ChannelHeaderStatus({
  agentId,
  channelAvailable,
  channelId,
  switching,
}: {
  agentId: string;
  channelAvailable: boolean | null;
  channelId: string;
  switching?: boolean;
}) {
  const record = useAgentRunActivity({ channelId, agentId });
  if (switching) {
    return (
      <span
        className="text-[11px] leading-3 text-muted-foreground"
        role="status"
      >
        Открываем…
      </span>
    );
  }
  if (!record || record.state.startedAt === null) {
    return channelAvailable === false ? (
      <span className="text-[11px] leading-3 text-muted-foreground">
        Недоступен
      </span>
    ) : null;
  }
  return (
    <span className="truncate text-[11px] leading-3 text-muted-foreground">
      {agentRunStatusLabel(record.state.status)}
      {channelAvailable === false ? " · недоступен" : ""}
    </span>
  );
}

/**
 * A channel holds exactly one coworker. More than one is not supported yet, and rendering a shared
 * transcript for several agents before the runtime can route between them would look like it works.
 */
function ChannelBody({
  channel,
  historyScope,
  isPending,
  hasError,
}: {
  channel: AgentChannel | undefined;
  historyScope: string | undefined;
  isPending: boolean;
  hasError: boolean;
}) {
  if (isPending || !historyScope)
    return <PageLoading label="Загрузка диалога…" />;
  if (hasError || !channel) {
    return (
      <p className="p-8 text-sm text-destructive" role="alert">
        Не удалось загрузить диалог.
      </p>
    );
  }

  const runtimeAgentId =
    channel.agentIds.length === 1 ? channel.agentIds[0] : undefined;
  if (!runtimeAgentId) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Диалоги с несколькими сотрудниками пока не поддерживаются.
      </p>
    );
  }

  // Remount on channel changes so CopilotKit agent/thread state cannot leak between channels.
  return (
    <CopilotProvider>
      <ChannelChat
        channel={channel}
        historyScope={historyScope}
        key={channel.id}
        runtimeAgentId={runtimeAgentId}
      />
    </CopilotProvider>
  );
}
