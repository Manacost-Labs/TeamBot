import {
  IconBolt,
  IconFileText,
  IconLogout,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  type LinkOptions,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { cancelChannelPrefetchScope } from "@/lib/channels/channel-prefetch";
import { conversationStateCache } from "@/lib/channels/conversation-state";
import {
  type ChannelSummary,
  channelKeys,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { useChannelEvents } from "@/lib/channels/use-channel-events";
import {
  agentRunActivityStore,
  clearAgentRunSessionScope,
  setAgentRunSessionScope,
} from "@/lib/copilot/run-activity-store";
import {
  monitorRunEvidenceOnce,
  readThreadExecution,
} from "@/lib/copilot/run-reconciliation";
import { isAgentRunActive } from "@/lib/copilot/run-state";
import {
  clearThreadMessagesCache,
  refreshThreadMessages,
} from "@/lib/copilot/thread-messages";
import { appConfig } from "@/lib/generated/application-config";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { relativeTime } from "@/lib/relative-time";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Channel } from "./channel";

const appLinkOptions = { to: "/" } satisfies LinkOptions;
const adminLinkOptions = { to: "/admin" } satisfies LinkOptions;
const settingsLinkOptions = { to: "/settings" } satisfies LinkOptions;

const userMenuItemClassName = "gap-2 px-2 py-1.5";

function UserAvatar() {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const initials =
    currentUser?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") ?? currentUser?.email.slice(0, 2).toUpperCase();

  return (
    <div className="size-[28px] bg-muted-foreground/10 text-foreground/70 rounded-full flex items-center justify-center text-xs overflow-hidden">
      {initials}
    </div>
  );
}

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name and the last thing said in it, because those are the two things the
 * row actually shows — searching against something invisible returns results a person cannot
 * account for. Message history beyond the last line is not here to search: it lives in the thread
 * store, and reaching for it is a server endpoint rather than a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.lastMessage].some((field) =>
      field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * Whether a Bot has said something this member has not had on screen yet.
 *
 * A Bot's message, and only a Bot's: your own message carries a null agent id and reading your own
 * words needs no marker. ISO-8601 strings compare correctly as strings, which is the same bet the
 * server's recency sort already makes.
 */
export function hasUnseenActivity(channel: ChannelSummary): boolean {
  if (channel.lastMessageAgentId === null || channel.lastMessageAt === null) {
    return false;
  }
  return (
    channel.lastReadAt === null || channel.lastMessageAt > channel.lastReadAt
  );
}

/** Unseen activity somewhere you are not looking. The open channel never shows the dot. */
export function isUnread(
  channel: ChannelSummary,
  openChannelId: string | undefined,
): boolean {
  return channel.id !== openChannelId && hasUnseenActivity(channel);
}

/**
 * A roster row that can animate on first appearance.
 *
 * A channel that did not exist fades in. Realtime order changes stay immediate because measuring
 * every row for a layout animation makes a channel switch visibly compete with the chat surface.
 */
const ChannelRow = memo(function ChannelRow({
  channel,
  animateEntrance,
  historyScope,
}: {
  channel: ChannelSummary;
  animateEntrance: boolean;
  historyScope?: string;
}) {
  const shouldReduceMotion = useReducedMotion();
  // Whether this row is unread, as a boolean, for the same reason `Channel` computes `isOpen`
  // that way: navigating re-renders the rows whose answer changed, not the whole roster.
  const unread = useParams({
    strict: false,
    select: (params) =>
      isUnread(channel, (params as { channelId?: string }).channelId),
  });
  return (
    <motion.div
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      initial={
        animateEntrance
          ? {
              opacity: 0,
              transform: shouldReduceMotion ? "none" : "translateY(-8px)",
            }
          : false
      }
      exit={{ opacity: 0 }}
      transition={{
        duration: animateEntrance ? ENTRANCE_SECONDS : 0,
        ease: EASE_OUT,
      }}
    >
      <Channel
        channelId={channel.id}
        historyScope={historyScope}
        participantIds={channel.agentIds}
        name={channel.name}
        lastMessage={channel.lastMessage ?? undefined}
        lastMessageAt={
          channel.lastMessageAt
            ? relativeTime(channel.lastMessageAt)
            : undefined
        }
        pinned={channel.pinned}
        threadId={channel.threadId}
        unread={unread}
      />
    </motion.div>
  );
});

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const channels = useInfiniteQuery(channelListQueryOptions());
  // One socket for the app, opened where the roster is kept live.
  useChannelEvents();
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const visibleChannels = useMemo(
    () => pinnedFirst(matchingChannels(channels.data, search)),
    [channels.data, search],
  );
  const currentUserId = currentUser?.id;
  useEffect(() => {
    if (!currentUserId || !channels.data) return;
    // Establish the scope here as well as in the shell: child effects can run before parent effects.
    setAgentRunSessionScope(currentUserId);
    const channelsById = new Map(
      channels.data.map((channel) => [channel.id, channel]),
    );
    for (const record of agentRunActivityStore.getRecordsNeedingReconciliation()) {
      const channel = channelsById.get(record.channelId);
      const token = agentRunActivityStore.getCurrentToken(record);
      if (!channel || !record.logicalRunId || !token) continue;
      const scope = { channelId: record.channelId, agentId: record.agentId };
      const reconciliationKey = [
        currentUserId,
        record.channelId,
        record.agentId,
        record.generation,
      ].join(":");
      void monitorRunEvidenceOnce(reconciliationKey, {
        logicalRunId: record.logicalRunId,
        readExecution: () =>
          readThreadExecution(channel.id, channel.threadId, record.agentId),
        readHistory: async () =>
          (
            await refreshThreadMessages(
              currentUserId,
              channel.threadId,
              record.agentId,
              { fresh: true },
            )
          ).messages,
        onEvidence: (evidence) => {
          agentRunActivityStore.reconcile(scope, { ...evidence, token });
        },
        onUnavailable: () => {
          agentRunActivityStore.markReconciliationPending(scope, token);
        },
        stillCurrent: () => {
          const current = agentRunActivityStore.getSnapshot(scope);
          return Boolean(
            current?.needsReconciliation &&
              current.generation === token.generation &&
              current.logicalRunId === token.logicalRunId &&
              isAgentRunActive(current.state.status),
          );
        },
      }).catch(() => {
        // Callback failures are not an authority answer; leave the generation recoverable so a
        // later shell revision can start a fresh monitor instead of silently declaring it failed.
        agentRunActivityStore.markReconciliationPending(scope, token);
      });
    }
  }, [channels.data, currentUserId]);
  const handleSignOut = async () => {
    if (currentUser) {
      // Stop speculative authenticated reads before the server session is revoked. Channel query
      // keys are shared, so leaving even a completed A entry would expose it to the next sign-in B.
      cancelChannelPrefetchScope(currentUser.id);
      await queryClient.cancelQueries({ queryKey: channelKeys.all });
      queryClient.removeQueries({ queryKey: channelKeys.all });
      clearThreadMessagesCache(currentUser.id);
    }
    await signOut.mutateAsync();
    if (currentUser) {
      clearAgentRunSessionScope(currentUser.id);
    }
    conversationStateCache.clear();
    await navigate({ to: "/sign" });
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="border-sidebar-border/60 border-b px-3 py-2.5">
        <SidebarMenu>
          <SidebarMenuItem className="flex h-9 flex-row items-center gap-1.5">
            <SidebarMenuButton
              className="h-9 font-semibold text-[14px] tracking-tight leading-tight"
              render={(props) => (
                <Link {...appLinkOptions} {...props}>
                  {appConfig.brand.productName}
                </Link>
              )}
            />
            <Button
              aria-label="Новый диалог"
              size="icon"
              variant="ghost"
              render={(props) => (
                <Link
                  {...props}
                  to="/channel/new"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <IconPlus />
            </Button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="scroll-fade-b">
        <SidebarMenu aria-busy={channels.isPending} aria-label="Диалоги">
          <SidebarGroup className="gap-2 px-3 py-3">
            <SidebarGroupLabel className="h-6 px-1 text-[11px] uppercase tracking-wide">
              <span>Диалоги</span>
              {channels.data ? (
                <span className="ml-auto tabular-nums text-sidebar-foreground/50">
                  {channels.data.length}
                </span>
              ) : null}
            </SidebarGroupLabel>
            <SidebarMenuItem>
              <InputGroup className="h-9 rounded-lg bg-background text-sm shadow-none">
                <InputGroupInput
                  aria-label="Поиск диалогов"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Поиск…"
                  value={search}
                />
                <InputGroupAddon>
                  <IconSearch />
                </InputGroupAddon>
              </InputGroup>
            </SidebarMenuItem>
            {/*
             * TWO DIFFERENT NOTHINGS, AND SAYING THE WRONG ONE IS ALARMING. A roster nobody has
             * used yet needs telling how to start. A roster that simply does not match what is in
             * the box has to say so and quote it back — told "you don't have channels yet" while
             * holding a typo, a person reads their conversations as gone.
             */}
            {searching && visibleChannels.length === 0 ? (
              <div className="py-4">
                <Empty className="min-h-40 border border-dashed">
                  <EmptyHeader>
                    <EmptyTitle>Диалоги не найдены</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      По запросу «{search.trim()}» ничего нет ни в названиях, ни
                      в последних сообщениях.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {!searching && channels.data?.length === 0 ? (
              <div className="py-4">
                <Empty className="min-h-40 border border-dashed">
                  <EmptyHeader>
                    <EmptyTitle>У вас пока нет диалогов</EmptyTitle>
                    <EmptyDescription className="text-pretty">
                      Начните общение с сотрудником в{" "}
                      {appConfig.brand.productName} — диалог появится здесь.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}
            {searching ? (
              visibleChannels.map((channel) => (
                <ChannelRow
                  animateEntrance={false}
                  key={channel.id}
                  channel={channel}
                  historyScope={currentUser?.id}
                />
              ))
            ) : (
              <AnimatePresence initial={false}>
                {visibleChannels.map((channel) => (
                  <ChannelRow
                    animateEntrance
                    channel={channel}
                    historyScope={currentUser?.id}
                    key={channel.id}
                  />
                ))}
              </AnimatePresence>
            )}
          </SidebarGroup>
        </SidebarMenu>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-px">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link
                  {...props}
                  to="/agents"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <div className="size-[28px] flex items-center justify-center">
                <IconBolt />
              </div>
              <span className="text-sm trackint-tight">Сотрудники</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="hover:bg-foreground/5 h-10"
              render={(props) => (
                <Link
                  {...props}
                  to="/results"
                  activeProps={{
                    className: "bg-foreground/5",
                  }}
                />
              )}
            >
              <div className="size-[28px] flex items-center justify-center">
                <IconFileText />
              </div>
              <span className="text-sm trackint-tight">Результаты</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="hover:bg-foreground/5 h-10" />
                }
              >
                <UserAvatar />
                <span className="text-sm trackint-tight">
                  {currentUser?.name || currentUser?.email}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="p-1.5"
                side="top"
                sideOffset={8}
              >
                {/* Admin routes are server-guarded; hide the entry for users who cannot open them. */}
                {currentUser?.role === "admin" ? (
                  <DropdownMenuItem
                    className={userMenuItemClassName}
                    render={<Link {...adminLinkOptions} />}
                  >
                    <IconShieldLock />
                    Управление
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  render={<Link {...settingsLinkOptions} />}
                >
                  <IconSettings />
                  Настройки
                </DropdownMenuItem>
                <DropdownMenuItem
                  className={userMenuItemClassName}
                  disabled={signOut.isPending}
                  onClick={handleSignOut}
                  variant="destructive"
                >
                  <IconLogout />
                  Выйти
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
