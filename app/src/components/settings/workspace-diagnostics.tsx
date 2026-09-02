import {
  IconAlertCircle,
  IconCheck,
  IconClock,
  IconLoader2,
  IconPlug,
  IconRefresh,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  aiConnectionKeys,
  type PersonalAiConnection,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connections/queries";
import {
  type AuthenticatedUser,
  authKeys,
  currentUserQueryOptions,
} from "@/lib/auth/queries";
import {
  type PluginConnectionHealth,
  pluginConnectionHealthQueryOptions,
  pluginKeys,
} from "@/lib/plugins/queries";
import {
  type RoutineWorkerHealth,
  routineKeys,
  routineWorkerHealthQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";

export type DiagnosticState =
  | "checking"
  | "connected"
  | "attention"
  | "unavailable"
  | "inactive";

export type WorkspaceDiagnostic = {
  id: "session" | "ai" | "integrations" | "automation";
  title: string;
  description: string;
  state: DiagnosticState;
  stateLabel: string;
  action?: {
    label: string;
    to: "/settings" | "/settings/connected-accounts" | "/routines";
  };
};

export type QuerySnapshot<T> = {
  data?: T;
  isError: boolean;
  isPending: boolean;
};

export type WorkspaceDiagnosticInput = {
  ai: QuerySnapshot<PersonalAiConnection | null>;
  connections: QuerySnapshot<PluginConnectionHealth>;
  currentUser: QuerySnapshot<AuthenticatedUser | null>;
  worker: QuerySnapshot<RoutineWorkerHealth>;
};

const STATE_APPEARANCE: Record<
  DiagnosticState,
  { icon: typeof IconCheck; className: string }
> = {
  checking: { icon: IconLoader2, className: "text-muted-foreground" },
  connected: { icon: IconCheck, className: "text-emerald-600" },
  attention: { icon: IconClock, className: "text-amber-600" },
  unavailable: { icon: IconAlertCircle, className: "text-destructive" },
  inactive: { icon: IconPlug, className: "text-muted-foreground" },
};

function aiDiagnostic(
  query: QuerySnapshot<PersonalAiConnection | null>,
): WorkspaceDiagnostic {
  if (query.isPending) {
    return {
      id: "ai",
      title: "Доступ к ИИ",
      description: "Проверяем подключение ChatGPT / Codex или OpenRouter.",
      state: "checking",
      stateLabel: "Проверяем",
    };
  }
  if (query.isError) {
    return {
      id: "ai",
      title: "Доступ к ИИ",
      description: "Не удалось проверить подключение. Повторите проверку.",
      state: "unavailable",
      stateLabel: "Ошибка проверки",
      action: { label: "Открыть настройки", to: "/settings" },
    };
  }
  if (query.data?.state === "active") {
    return {
      id: "ai",
      title: "Доступ к ИИ",
      description:
        query.data.provider === "chatgpt"
          ? "ChatGPT / Codex подключён для этой учётной записи."
          : "OpenRouter подключён для этой учётной записи.",
      state: "connected",
      stateLabel: "Подключено",
      action: { label: "Изменить", to: "/settings" },
    };
  }
  return {
    id: "ai",
    title: "Доступ к ИИ",
    description:
      "Подключите ChatGPT / Codex или OpenRouter, чтобы запускать сотрудников.",
    state: "attention",
    stateLabel: "Нужно подключить",
    action: { label: "Подключить", to: "/settings" },
  };
}

function integrationsDiagnostic(
  query: QuerySnapshot<PluginConnectionHealth>,
): WorkspaceDiagnostic {
  if (query.isPending) {
    return {
      id: "integrations",
      title: "Интеграции",
      description: "Проверяем доступные подключения и выданные разрешения.",
      state: "checking",
      stateLabel: "Проверяем",
    };
  }
  if (query.isError) {
    return {
      id: "integrations",
      title: "Интеграции",
      description: "Не удалось проверить интеграции. Повторите проверку.",
      state: "unavailable",
      stateLabel: "Ошибка проверки",
      action: {
        label: "Открыть интеграции",
        to: "/settings/connected-accounts",
      },
    };
  }

  const available = query.data?.available ?? [];
  if (available.length === 0) {
    return {
      id: "integrations",
      title: "Интеграции",
      description: "Личные интеграции пока не включены администратором.",
      state: "inactive",
      stateLabel: "Пока недоступно",
      action: {
        label: "Открыть интеграции",
        to: "/settings/connected-accounts",
      },
    };
  }

  const connected = new Set(
    (query.data?.connected ?? []).map((connection) => connection.serverId),
  );
  const connectedCount = available.filter((entry) =>
    connected.has(entry.serverId),
  ).length;
  if (connectedCount === available.length) {
    return {
      id: "integrations",
      title: "Интеграции",
      description: `Подключено: ${connectedCount} из ${available.length}.`,
      state: "connected",
      stateLabel: "Готово",
      action: {
        label: "Управлять",
        to: "/settings/connected-accounts",
      },
    };
  }
  return {
    id: "integrations",
    title: "Интеграции",
    description: `Подключено: ${connectedCount} из ${available.length}. Можно выдать недостающий доступ.`,
    state: "attention",
    stateLabel: "Нужно настроить",
    action: {
      label: "Настроить",
      to: "/settings/connected-accounts",
    },
  };
}

function automationDiagnostic(
  query: QuerySnapshot<RoutineWorkerHealth>,
): WorkspaceDiagnostic {
  if (query.isPending) {
    return {
      id: "automation",
      title: "Автоматизация",
      description: "Проверяем обработчик задач по расписанию.",
      state: "checking",
      stateLabel: "Проверяем",
    };
  }
  if (query.isError || query.data?.status === "unavailable") {
    return {
      id: "automation",
      title: "Автоматизация",
      description:
        "Обработчик расписаний недоступен. Задачи по расписанию могут не запускаться.",
      state: "unavailable",
      stateLabel: "Недоступно",
      action: { label: "Открыть расписание", to: "/routines" },
    };
  }
  if (query.data?.status === "stale") {
    return {
      id: "automation",
      title: "Автоматизация",
      description:
        "Обработчик давно не отвечал. Проверьте расписание и повторите запуск.",
      state: "attention",
      stateLabel: "Требует внимания",
      action: { label: "Открыть расписание", to: "/routines" },
    };
  }
  return {
    id: "automation",
    title: "Автоматизация",
    description: "Обработчик расписаний отвечает и готов запускать задачи.",
    state: "connected",
    stateLabel: "Работает",
    action: { label: "Открыть расписание", to: "/routines" },
  };
}

/** Build safe, user-facing diagnostics without carrying credentials or upstream error bodies. */
export function buildWorkspaceDiagnostics(
  input: WorkspaceDiagnosticInput,
): WorkspaceDiagnostic[] {
  const session: WorkspaceDiagnostic = input.currentUser.isPending
    ? {
        id: "session",
        title: "Сессия ManacostTeam",
        description: "Проверяем текущую учётную запись.",
        state: "checking",
        stateLabel: "Проверяем",
      }
    : input.currentUser.isError || !input.currentUser.data
      ? {
          id: "session",
          title: "Сессия ManacostTeam",
          description: "Не удалось подтвердить текущую сессию. Войдите снова.",
          state: "unavailable",
          stateLabel: "Нужен вход",
        }
      : {
          id: "session",
          title: "Сессия ManacostTeam",
          description: `Вы вошли как ${input.currentUser.data.name?.trim() || input.currentUser.data.email}.`,
          state: "connected",
          stateLabel: "Активна",
        };

  return [
    session,
    aiDiagnostic(input.ai),
    integrationsDiagnostic(input.connections),
    automationDiagnostic(input.worker),
  ];
}

function statusIcon(state: DiagnosticState) {
  const appearance = STATE_APPEARANCE[state];
  const Icon = appearance.icon;
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4", appearance.className, {
        "animate-spin": state === "checking",
      })}
    />
  );
}

export function WorkspaceDiagnostics() {
  const queryClient = useQueryClient();
  const currentUser = useQuery(currentUserQueryOptions());
  const actorId = currentUser.data?.id ?? "";
  const ai = useQuery(personalAiConnectionQueryOptions(actorId));
  const connections = useQuery(pluginConnectionHealthQueryOptions());
  const worker = useQuery(routineWorkerHealthQueryOptions());
  const diagnostics = useMemo(
    () =>
      buildWorkspaceDiagnostics({
        ai,
        connections,
        currentUser,
        worker,
      }),
    [ai, connections, currentUser, worker],
  );
  const refreshing =
    currentUser.isFetching ||
    ai.isFetching ||
    connections.isFetching ||
    worker.isFetching;

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: authKeys.currentUser() }),
      actorId
        ? queryClient.invalidateQueries({
            queryKey: aiConnectionKeys.status(actorId),
          })
        : Promise.resolve(),
      queryClient.invalidateQueries({
        queryKey: pluginKeys.connectionHealth(),
      }),
      queryClient.invalidateQueries({ queryKey: routineKeys.health() }),
    ]);
  }

  return (
    <PageSection
      action={
        <Button
          aria-label="Обновить проверки"
          disabled={refreshing}
          onClick={() => void refresh()}
          size="sm"
          variant="outline"
        >
          <IconRefresh className={cn({ "animate-spin": refreshing })} />
          Обновить
        </Button>
      }
      description="Один безопасный обзор состояния рабочего пространства. Секреты и содержимое подключённых сервисов здесь не показываются."
      title="Проверка подключений"
    >
      <PageRows>
        {diagnostics.map((diagnostic, index) => (
          <div key={diagnostic.id}>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>
                  <span className="flex items-center gap-2">
                    {statusIcon(diagnostic.state)}
                    {diagnostic.title}
                  </span>
                </ItemTitle>
                <p className="text-muted-foreground text-sm">
                  {diagnostic.description}
                </p>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {diagnostic.stateLabel}
                </span>
                {diagnostic.action ? (
                  <Button
                    render={<Link to={diagnostic.action.to} />}
                    size="sm"
                    variant="ghost"
                  >
                    {diagnostic.action.label}
                  </Button>
                ) : null}
              </ItemActions>
            </Item>
            {index < diagnostics.length - 1 ? <Separator /> : null}
          </div>
        ))}
      </PageRows>
    </PageSection>
  );
}
