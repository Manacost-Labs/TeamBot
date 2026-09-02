import {
  IconBolt,
  IconClock,
  IconMessagePlus,
  IconSettings,
} from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { AgentCard } from "@/components/agents/agent-card";
import { Composer, toAgentOptions } from "@/components/channels/composer";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { buildAttachmentMessageContent } from "@/lib/attachments/message-content";
import { finishWithCommittedAttachments } from "@/lib/channels/prepared-channel";
import type { ChannelSummary } from "@/lib/channels/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { appConfig } from "@/lib/generated/application-config";
import { newId } from "@/lib/new-id";
import {
  abandonAgentRunTiming,
  beginAgentRunTiming,
} from "@/lib/performance/workspace-timing";
import { relativeTime } from "@/lib/relative-time";

export const Route = createFileRoute("/_authed/_app/")({
  component: RouteComponent,
});

export const HOME_QUICK_ACTIONS = [
  {
    to: "/channel/new",
    title: "Новый диалог",
    description: "Поставить задачу сотруднику",
    icon: IconMessagePlus,
  },
  {
    to: "/agents",
    title: "Сотрудники",
    description: "Посмотреть доступные роли",
    icon: IconBolt,
  },
  {
    to: "/routines",
    title: "Расписание",
    description: "Проверить автоматические задачи",
    icon: IconClock,
  },
  {
    to: "/settings",
    title: "Настройки",
    description: "Подключения и оформление",
    icon: IconSettings,
  },
] as const;

export function recentChannels(channels: ChannelSummary[] | undefined) {
  return (channels ?? [])
    .filter((channel) => channel.lastMessageAt !== null)
    .slice(0, 3);
}

function RouteComponent() {
  const { data: agents } = useQuery(agentListQueryOptions());
  const { data: channels } = useInfiniteQuery(channelListQueryOptions());
  const explore = agents?.filter((a) => !a.mine && a.visibility === "public");
  const recent = recentChannels(channels);
  const { finish, pending, prepare } = useStartChannel();
  const preparedRecipient = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Default recipient when the composer draft has no mention. */
  const fallback = explore?.[0] ?? agents?.[0];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-10 md:py-14">
        <header className="flex flex-col gap-2">
          <p className="text-sm uppercase text-muted-foreground font-medium tracking-tight">
            {appConfig.brand.productName}
          </p>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
            Что будем делать?
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Поставьте задачу сотруднику или продолжите недавний диалог.
          </p>
        </header>

        <section
          aria-label="Новый диалог"
          className="flex flex-col items-center"
        >
          <Composer
            agents={toAgentOptions(agents)}
            className="w-full max-w-3xl"
            disabled={!fallback}
            onSubmit={async (draft, attachments) => {
              // A channel is pinned to one coworker for the life of its thread, so the coworker is
              // chosen now, before it is created. An `@` is an explicit choice and is honoured as-is.
              // With no `@`, the message is routed to the coworker it is for; if that routing cannot
              // run, it falls back to the same default the composer used to always use.
              setError(null);
              const messageId = newId();
              beginAgentRunTiming(messageId);
              try {
                let agentId: string | undefined =
                  preparedRecipient.current ?? draft.agentId ?? undefined;
                if (!preparedRecipient.current && agentId) {
                  /*
                   * Told to the server so the choice is recorded, and its answer thrown away: the
                   * person already decided and nothing here may change that. Failing to write the
                   * audit row must not stop the conversation, so a rejection is swallowed whole.
                   */
                  await routeMessage(draft.text, agentId).catch(
                    () => undefined,
                  );
                } else if (!preparedRecipient.current && draft.text) {
                  try {
                    agentId = (await routeMessage(draft.text)).agentId;
                  } catch {
                    agentId = fallback?.id;
                  }
                }
                agentId ??= fallback?.id;
                if (!agentId) {
                  abandonAgentRunTiming(messageId);
                  return;
                }
                preparedRecipient.current = agentId;
                const channel = await prepare(agentId);
                const uploaded = await attachments.upload(channel.id);
                const content = buildAttachmentMessageContent(
                  draft.text,
                  uploaded,
                );
                await finishWithCommittedAttachments(
                  () => finish(channel, content, messageId),
                  attachments.commit,
                );
                preparedRecipient.current = null;
              } catch (caught) {
                abandonAgentRunTiming(messageId);
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "Не удалось начать диалог.",
                );
                throw caught;
              }
            }}
            pending={pending}
          />
          {fallback ? (
            // Said out loud: a message that silently reaches somebody you did not choose is the
            // kind of surprise that costs trust the first time it happens.
            <p className="mt-2 w-full max-w-3xl text-xs text-muted-foreground">
              Сообщение получит подходящий сотрудник. Введите <code>@</code>,
              чтобы выбрать сотрудника самостоятельно.
            </p>
          ) : null}
          {error ? (
            <p
              className="mt-2 w-full max-w-3xl text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="quick-actions-title">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-bold text-lg" id="quick-actions-title">
                Быстрые действия
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Основные разделы ManacostTeam в одном месте.
              </p>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {HOME_QUICK_ACTIONS.map((action) => (
              <Link
                key={action.title}
                className="group flex min-h-28 flex-col justify-between rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                to={action.to}
              >
                <action.icon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-sm">{action.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {action.description}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        {recent.length > 0 ? (
          <section aria-labelledby="recent-title">
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <h2 className="font-bold text-lg" id="recent-title">
                  Недавние диалоги
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Продолжите с того места, где остановились.
                </p>
              </div>
              <Link
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                to="/"
              >
                Все диалоги в меню
              </Link>
            </div>
            <div className="mt-4 grid gap-2">
              {recent.map((channel) => (
                <Link
                  key={channel.id}
                  className="flex min-w-0 items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  params={{ channelId: channel.id }}
                  to="/channel/$channelId"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium text-sm">
                      {channel.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {channel.lastMessage}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {channel.lastMessageAt
                      ? relativeTime(channel.lastMessageAt)
                      : ""}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="agents-title">
          <h2 className="font-bold text-lg" id="agents-title">
            Сотрудники
          </h2>
          <div className="mt-4 flex flex-row gap-4 overflow-x-auto pb-2">
            {!!explore?.length &&
              explore.map((agent) => (
                <Link
                  key={agent.id}
                  className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  to="/channel/new"
                  search={{
                    agent: agent.id,
                  }}
                >
                  <AgentCard agent={agent} />
                </Link>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}
