import {
  IconHistory,
  IconPencil,
  IconPlayerPlay,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { relativeTime } from "@/lib/relative-time";
import {
  deleteRoutineMutationOptions,
  runRoutineNowMutationOptions,
  setRoutineEnabledMutationOptions,
  updateRoutineMutationOptions,
} from "@/lib/routines/mutations";
import {
  type RoutineRecord,
  routineRunsQueryOptions,
  routinesQueryOptions,
} from "@/lib/routines/queries";
import { queryClient } from "@/query-client";
import { RoutineWorkerHealthIndicator } from "./routine-worker-health";

/**
 * What the last-run cell says, and in what tone.
 *
 * `lastRun === null` and `lastRun.status === null` are different facts, and saying the wrong one
 * invents news: the first is "this routine has never finished a run," the second is "one is open
 * right now" — which is also what a run stuck open after repeated dispatch failures looks like from
 * here. Neither is a failure, so neither gets the destructive tone; only `status: "failed"` does.
 */
function lastRunLabel(lastRun: RoutineRecord["lastRun"]): {
  text: string;
  className: string;
} {
  if (lastRun === null) {
    return { text: "Ещё не запускалось", className: "text-muted-foreground" };
  }
  if (lastRun.status === null) {
    return { text: "Выполняется…", className: "text-muted-foreground" };
  }
  const when = lastRun.at ? relativeTime(lastRun.at) : "недавно";
  if (lastRun.status === "failed") {
    return { text: `Ошибка: ${when}`, className: "text-destructive" };
  }
  if (lastRun.status === "skipped") {
    return {
      text: `Пропущено: ${when}`,
      className: "text-amber-600 dark:text-amber-500",
    };
  }
  if (lastRun.status === "succeeded") {
    return { text: `Выполнено: ${when}`, className: "text-muted-foreground" };
  }
  // An outcome this DTO doesn't recognise degrades to a neutral label rather than an invented
  // success — the contract typing (`RoutineRunOutcome | null`) makes a fourth outcome a build-time
  // error, but this is the runtime fallback if that ever slips through.
  return { text: `Завершено: ${when}`, className: "text-muted-foreground" };
}

const schedulePresets = [
  { id: "every-15-minutes", label: "Каждые 15 минут", cron: "*/15 * * * *" },
  { id: "hourly", label: "Каждый час", cron: "0 * * * *" },
  { id: "daily", label: "Каждый день в 09:00", cron: "0 9 * * *" },
  { id: "weekdays", label: "По будням в 09:00", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Каждый понедельник в 09:00", cron: "0 9 * * 1" },
  { id: "monthly", label: "Первого числа в 09:00", cron: "0 9 1 * *" },
] as const;

type EditDraft = Pick<
  RoutineRecord,
  | "id"
  | "agentId"
  | "instruction"
  | "cron"
  | "timezone"
  | "channel"
  | "overlapPolicy"
>;

function durationLabel(durationMs: number | null): string {
  if (durationMs === null) return "выполняется";
  if (durationMs < 60_000)
    return `${Math.max(1, Math.round(durationMs / 1000))} сек`;
  return `${Math.round(durationMs / 60_000)} мин`;
}

/**
 * The one list the Routines page shows: every standing instruction the signed-in person owns, a
 * switch to stop one taking effect, and a delete that ends it for good.
 */
export function RoutinesList() {
  const routines = useQuery(routinesQueryOptions());
  const setEnabled = useMutation(setRoutineEnabledMutationOptions(queryClient));
  const deleteRoutine = useMutation(deleteRoutineMutationOptions(queryClient));
  const updateRoutine = useMutation(updateRoutineMutationOptions(queryClient));
  const runNow = useMutation(runRoutineNowMutationOptions(queryClient));
  /** The routine a delete is being confirmed for, or null. Its own dialog rather than one per row. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const history = useQuery(routineRunsQueryOptions(historyId));
  const rows = routines.data ?? [];
  const confirming = rows.find((row) => row.id === confirmingId) ?? null;

  return (
    <PageSection>
      <RoutineWorkerHealthIndicator />
      {setEnabled.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setEnabled.error.message}
        </p>
      ) : null}
      {runNow.error ? (
        <p className="text-destructive text-sm" role="alert">
          {runNow.error.message}
        </p>
      ) : null}

      {/* Pending renders nothing: the empty-state sentence would otherwise flash for the fetch. */}
      {routines.isPending ? null : routines.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          Не удалось загрузить расписание.
        </p>
      ) : rows.length === 0 ? (
        <PageEmpty>
          Пока ничего не запланировано. Напишите сотруднику: «каждый будний день
          в 9:00…» — и задача появится здесь.
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((routine, index) => {
            const { text: lastRunText, className: lastRunClassName } =
              lastRunLabel(routine.lastRun);
            return (
              <div key={routine.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {routine.schedule}
                      <span className="font-normal text-muted-foreground text-xs">
                        {routine.timezone}
                      </span>
                    </ItemTitle>
                    <ItemDescription className="line-clamp-3">
                      {routine.instruction}
                    </ItemDescription>
                    {/* A set, so it wraps onto its own line rather than crowding the title. */}
                    <ItemFooter>
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        <span
                          className={
                            routine.channel.gone
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        >
                          {routine.channel.gone
                            ? "Диалог удалён"
                            : (routine.channel.name ?? "Диалог без названия")}
                        </span>
                        <span className={lastRunClassName}>{lastRunText}</span>
                        {/*
                         * Enabled only: the store recomputes nextRunAt on cron/timezone change or
                         * re-enable, so a disabled routine's stamp is frozen in the past — rendering
                         * it unguarded would announce a stale "3 days ago" as the next run.
                         */}
                        {routine.enabled ? (
                          <span className="text-muted-foreground">
                            Следующий запуск {relativeTime(routine.nextRunAt)}
                          </span>
                        ) : null}
                      </div>
                    </ItemFooter>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Запустить сейчас задачу ${routine.schedule}`}
                      disabled={
                        runNow.isPending && runNow.variables === routine.id
                      }
                      onClick={() => runNow.mutate(routine.id)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <IconPlayerPlay />
                      Запустить
                    </Button>
                    <Button
                      aria-label={`История запусков задачи ${routine.schedule}`}
                      onClick={() => setHistoryId(routine.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconHistory />
                    </Button>
                    <Button
                      aria-label={`Изменить задачу ${routine.schedule}`}
                      onClick={() => {
                        updateRoutine.reset();
                        setEditing({
                          id: routine.id,
                          agentId: routine.agentId,
                          instruction: routine.instruction,
                          cron: routine.cron,
                          timezone: routine.timezone,
                          channel: routine.channel,
                          overlapPolicy: routine.overlapPolicy,
                        });
                      }}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconPencil />
                    </Button>
                    {/*
                     * Binary and immediate: it takes effect when switched, there is no save.
                     * Disabled only while its own write is in flight, so switching one routine
                     * does not freeze the rest of the list — the same idiom the per-tool plugins
                     * page uses for its per-Bot grant switches.
                     */}
                    <Switch
                      aria-label={`Включить задачу по расписанию ${routine.schedule}`}
                      checked={routine.enabled}
                      disabled={
                        setEnabled.isPending &&
                        setEnabled.variables?.id === routine.id
                      }
                      onCheckedChange={(next) =>
                        setEnabled.mutate({ id: routine.id, enabled: next })
                      }
                    />
                    <Button
                      aria-label={`Удалить задачу по расписанию ${routine.schedule}`}
                      onClick={() => {
                        deleteRoutine.reset();
                        setConfirmingId(routine.id);
                      }}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
                {index !== rows.length - 1 && <Separator />}
              </div>
            );
          })}
        </PageRows>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        open={editing !== null}
      >
        <DialogContent>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editing) return;
              updateRoutine.mutate(
                {
                  id: editing.id,
                  instruction: editing.instruction,
                  cron: editing.cron,
                  timezone: editing.timezone,
                },
                { onSuccess: () => setEditing(null) },
              );
            }}
          >
            <DialogHeader>
              <DialogTitle>Изменить расписание</DialogTitle>
              <DialogDescription>
                Время считается в выбранном часовом поясе, включая переходы на
                летнее время.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <label className="grid gap-2 text-sm" htmlFor="routine-preset">
                <span className="font-medium">Готовый вариант</span>
                <Select
                  onValueChange={(value) => {
                    const preset = schedulePresets.find(
                      (item) => item.id === value,
                    );
                    if (preset) {
                      setEditing((current) =>
                        current ? { ...current, cron: preset.cron } : current,
                      );
                    }
                  }}
                  value={
                    schedulePresets.find((item) => item.cron === editing?.cron)
                      ?.id ?? "custom"
                  }
                >
                  <SelectTrigger className="w-full" id="routine-preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {schedulePresets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                      <SelectItem value="custom">Своё расписание</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-2 text-sm" htmlFor="routine-cron">
                <span className="font-medium">Расписание (cron)</span>
                <Input
                  id="routine-cron"
                  onChange={(event) =>
                    setEditing((current) =>
                      current
                        ? { ...current, cron: event.target.value }
                        : current,
                    )
                  }
                  required
                  value={editing?.cron ?? ""}
                />
                <span className="text-muted-foreground text-xs">
                  Пять полей: минута, час, день месяца, месяц, день недели. Не
                  чаще одного запуска в 15 минут.
                </span>
              </label>
              <label className="grid gap-2 text-sm" htmlFor="routine-timezone">
                <span className="font-medium">Часовой пояс</span>
                <Input
                  id="routine-timezone"
                  onChange={(event) =>
                    setEditing((current) =>
                      current
                        ? { ...current, timezone: event.target.value }
                        : current,
                    )
                  }
                  placeholder="Europe/Warsaw"
                  required
                  value={editing?.timezone ?? ""}
                />
              </label>
              <label
                className="grid gap-2 text-sm"
                htmlFor="routine-instruction"
              >
                <span className="font-medium">Задание сотруднику</span>
                <Textarea
                  id="routine-instruction"
                  onChange={(event) =>
                    setEditing((current) =>
                      current
                        ? { ...current, instruction: event.target.value }
                        : current,
                    )
                  }
                  required
                  rows={5}
                  value={editing?.instruction ?? ""}
                />
              </label>
              <div className="rounded-lg border p-3 text-muted-foreground text-xs">
                <p>Сотрудник: {editing?.agentId}</p>
                <p>
                  Диалог:{" "}
                  {editing?.channel.gone
                    ? "удалён"
                    : (editing?.channel.name ?? "без названия")}
                </p>
                <p>При пересечении: пропустить новый запуск</p>
              </div>
              {updateRoutine.error ? (
                <p className="text-destructive text-sm" role="alert">
                  {updateRoutine.error.message}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button
                onClick={() => setEditing(null)}
                type="button"
                variant="ghost"
              >
                Отмена
              </Button>
              <Button disabled={updateRoutine.isPending} type="submit">
                {updateRoutine.isPending ? "Сохраняем…" : "Сохранить"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setHistoryId(null);
        }}
        open={historyId !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>История запусков</DialogTitle>
            <DialogDescription>
              Последние 20 запусков. Технические и секретные детали ошибок здесь
              не показываются.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {history.isPending ? (
              <p className="text-muted-foreground text-sm">Загружаем…</p>
            ) : history.error ? (
              <p className="text-destructive text-sm" role="alert">
                Не удалось загрузить историю запусков.
              </p>
            ) : (history.data?.length ?? 0) === 0 ? (
              <p className="text-muted-foreground text-sm">
                Запусков пока не было.
              </p>
            ) : (
              <div className="divide-y">
                {history.data?.map((run) => (
                  <div className="grid gap-1 py-3 first:pt-0" key={run.id}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span>
                        {run.status === "succeeded"
                          ? "✓ Выполнено"
                          : run.status === "failed"
                            ? "✕ Ошибка"
                            : run.status === "skipped"
                              ? "○ Пропущено"
                              : "● Выполняется"}
                      </span>
                      <span className="text-muted-foreground">
                        {durationLabel(run.durationMs)}
                      </span>
                    </div>
                    <time
                      className="text-muted-foreground text-xs"
                      dateTime={run.startedAt}
                    >
                      {new Date(run.startedAt).toLocaleString()}
                    </time>
                    {run.error ? (
                      <p className="text-muted-foreground text-xs">
                        {run.error}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/*
       * One dialog for the whole list rather than one per row, keyed by which routine is being
       * confirmed. It names the schedule, not the id or the instruction, because the schedule is
       * the word a person reads first on the row and the one most likely to tell two routines apart
       * at a glance.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmingId(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить «{confirming?.schedule}»?</DialogTitle>
            <DialogDescription>
              Задача больше не будет запускаться по этому расписанию. Отменить
              удаление после подтверждения нельзя.
            </DialogDescription>
          </DialogHeader>
          {deleteRoutine.error ? (
            <p className="text-destructive text-sm" role="alert">
              {deleteRoutine.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              onClick={() => setConfirmingId(null)}
              size="sm"
              variant="ghost"
            >
              Отмена
            </Button>
            <Button
              disabled={deleteRoutine.isPending}
              onClick={() => {
                if (!confirmingId) return;
                deleteRoutine.mutate(confirmingId, {
                  onSuccess: () => setConfirmingId(null),
                });
              }}
              size="sm"
              variant="destructive"
            >
              {deleteRoutine.isPending ? "Удаляем…" : "Удалить"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
