import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  groupOomolTools,
  type OomolAgent,
  type OomolReadinessState,
  oomolReadiness,
  oomolRecoveryHint,
} from "@/lib/plugins/oomol-readiness";
import type { PluginServer } from "@/lib/plugins/queries";

const COPY: Record<OomolReadinessState, { title: string; detail: string }> = {
  "not-configured": {
    title: "Подключите OOMOL",
    detail:
      "Свяжите аккаунты на сайте OOMOL, затем добавьте его API-ключ здесь. Собственный проект Google Cloud для этого подключения не нужен.",
  },
  "missing-key": {
    title: "Добавьте API-ключ",
    detail:
      "Коннектор добавлен, но ключ не сохранён. Повторно включать его или удалять существующие права не нужно.",
  },
  unchecked: {
    title: "Проверьте список действий",
    detail: "Ключ сохранён, но успешное получение списка ещё не подтверждено.",
  },
  checking: {
    title: "Получаем список от OOMOL…",
    detail:
      "Проверяем доступ к каталогу. Документы, таблицы и репозитории не изменяются.",
  },
  failed: {
    title: "Нужна повторная проверка",
    detail:
      "Последняя попытка не подтвердила доступ к каталогу. Выданные права не изменены.",
  },
  empty: {
    title: "Действия не найдены",
    detail:
      "OOMOL ответил, но вернул пустой список. Проверьте аккаунты и доступные действия в OOMOL, затем обновите список.",
  },
  "needs-grants": {
    title: "Выберите агентов и действия",
    detail:
      "Каталог получен. Среди доступных агентов нет получателей этих действий — выберите, кому и что разрешить.",
  },
  "roster-unavailable": {
    title: "Список агентов пока недоступен",
    detail:
      "Каталог получен, но доступ агентов ещё нельзя определить. Дождитесь загрузки списка; если он не появится, обновите страницу.",
  },
  "callback-needed": {
    title: "Настройте вызов инструментов",
    detail:
      "Права выданы, но у этих агентов не настроен доступ к вызову инструментов. Проверьте callback-токен в настройках агента или общий токен сервера.",
  },
  "callback-partial": {
    title: "Не все агенты настроены",
    detail:
      "У части получателей прав не настроен вызов инструментов. Откройте действие в разделе Tools ниже, чтобы проверить каждого агента.",
  },
  catalogued: {
    title: "Каталог получен, права выданы",
    detail:
      "У получателей из доступного списка указаны настройки вызова инструментов. Их доступ и ограничения проверяются при каждом вызове.",
  },
};

/** Read-only projection; buttons delegate to the existing explicit setup and grant dialogs. */
export function OomolReadiness({
  server,
  refreshing = false,
  error,
  agents,
  botsMayCallBack,
  onConfigure,
  onRefresh,
  onGrant,
}: {
  server?: PluginServer;
  refreshing?: boolean;
  error?: unknown;
  agents?: readonly OomolAgent[];
  botsMayCallBack?: boolean;
  onConfigure: () => void;
  onRefresh: () => void;
  onGrant: () => void;
}) {
  const headingId = useId();
  const state = oomolReadiness(server, {
    refreshing,
    error,
    agents,
    botsMayCallBack,
  });
  const copy = COPY[state];
  const groups = groupOomolTools(server?.tools ?? [], agents);
  const needsKey = state === "not-configured" || state === "missing-key";
  const discovered =
    state === "needs-grants" ||
    state === "catalogued" ||
    state === "empty" ||
    state === "roster-unavailable" ||
    state === "callback-needed" ||
    state === "callback-partial";
  const canGrant = (agents?.length ?? 0) > 0 && discovered && groups.length > 0;
  const checkedAt = server?.toolsRefreshedAt;
  const validCheckedAt = checkedAt && Number.isFinite(Date.parse(checkedAt));

  return (
    <section
      aria-labelledby={headingId}
      className="mt-6 min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5"
    >
      <h2 className="font-semibold text-base" id={headingId}>
        Подключение OOMOL
      </h2>
      <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
        Общее подключение команды: используется аккаунт владельца сохранённого
        ключа OOMOL, а не личный аккаунт каждого участника. Доступ получают
        только агенты с выданными правами.
      </p>
      <ol
        aria-label="Этапы подключения"
        className="mt-4 flex flex-col gap-2 border-border border-y py-3 text-sm sm:flex-row sm:justify-between"
      >
        <li>1. Ключ — {server?.hasCredential ? "сохранён" : "не добавлен"}</li>
        <li>2. Каталог — {discovered ? "получен" : "нужна проверка"}</li>
        <li>
          3. Права — {state === "catalogued" ? "выданы" : "проверьте доступ"}
        </li>
      </ol>
      <div className="mt-4" role="status">
        <p className="font-medium text-sm">{copy.title}</p>
        <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
          {copy.detail}
        </p>
      </div>
      {state === "failed" ? (
        <p
          className="mt-3 text-destructive text-sm leading-relaxed"
          role="alert"
        >
          {oomolRecoveryHint(error || server?.lastError)}
        </p>
      ) : null}
      {groups.length > 0 ? (
        <div className="mt-4">
          <h3 className="font-medium text-sm">
            {discovered
              ? "Найденные действия"
              : "Предыдущий список — доступ сейчас не подтверждён"}
          </h3>
          <p className="mt-1 text-muted-foreground text-xs">
            Сгруппировано по названиям действий, не по личным аккаунтам.
          </p>
          <ul
            aria-label="Сервисы в каталоге действий"
            className="mt-2 divide-y divide-border"
          >
            {groups.map((group) => (
              <li
                className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm"
                key={group.id}
              >
                <span className="min-w-0 break-all font-medium">
                  {group.title}
                </span>
                <span className="text-muted-foreground text-xs">
                  Действий: {group.toolCount} ·{" "}
                  {agents ? (
                    <>
                      Доступных агентов с правами: {group.grantedAgentCount}
                      {group.unresolvedAgentCount > 0
                        ? ` · Вне доступного списка: ${group.unresolvedAgentCount}`
                        : ""}
                    </>
                  ) : (
                    "Права — список агентов недоступен"
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {validCheckedAt ? (
        <p className="mt-3 text-muted-foreground text-xs">
          Последний полученный каталог:{" "}
          <time dateTime={checkedAt}>
            {new Date(checkedAt).toLocaleString("ru-RU")}
          </time>
        </p>
      ) : null}
      <p className="mt-3 text-muted-foreground text-xs leading-relaxed">
        Получение каталога не проверяет выполнение задач в сервисах. Действия
        OOMOL требуют проверки прав на изменение; выдача доступа не отменяет
        ограничения агента.
      </p>
      {agents?.length === 0 && discovered && groups.length > 0 ? (
        <p className="mt-3 text-sm">
          В доступном списке пока нет агентов. Верните скрытого агента в список
          или создайте нового, затем выберите нужные действия в разделе Tools
          ниже.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          className="min-h-11 whitespace-normal"
          disabled={refreshing}
          onClick={onConfigure}
          type="button"
          variant={needsKey ? "default" : "outline"}
        >
          {state === "not-configured"
            ? "Подключить OOMOL"
            : state === "missing-key"
              ? "Добавить ключ"
              : "Заменить ключ"}
        </Button>
        {server?.hasCredential ? (
          <Button
            className="min-h-11 whitespace-normal"
            disabled={refreshing}
            onClick={onRefresh}
            type="button"
            variant={canGrant ? "outline" : "default"}
          >
            {refreshing
              ? "Проверяем…"
              : state === "failed"
                ? "Повторить проверку"
                : "Проверить список действий"}
          </Button>
        ) : null}
        {canGrant ? (
          <Button
            className="min-h-11 whitespace-normal"
            onClick={onGrant}
            type="button"
          >
            Выбрать агентов и действия
          </Button>
        ) : null}
      </div>
    </section>
  );
}
