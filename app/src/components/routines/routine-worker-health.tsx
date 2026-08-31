import { useQuery } from "@tanstack/react-query";
import { relativeTime } from "@/lib/relative-time";
import {
  type RoutineWorkerHealth,
  routineWorkerHealthQueryOptions,
} from "@/lib/routines/queries";
import { cn } from "@/lib/utils";

const appearance = {
  operational: {
    label: "Обработчик расписаний работает",
    container: "border-border text-foreground",
    dot: "bg-emerald-500",
  },
  stale: {
    label: "Обработчик расписаний давно не отвечал",
    container:
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100",
    dot: "bg-amber-500",
  },
  unavailable: {
    label: "Обработчик расписаний недоступен",
    container: "border-destructive/40 bg-destructive/5 text-destructive",
    dot: "bg-destructive",
  },
} as const;

/** A small, explicit operational signal that stays visible even when the routine list is empty. */
export function RoutineWorkerHealthStatus({
  worker,
}: {
  worker: RoutineWorkerHealth;
}) {
  const state = appearance[worker.status];
  const role = worker.status === "operational" ? "status" : "alert";

  return (
    <div
      aria-live="polite"
      className={cn(
        "mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        state.container,
      )}
      role={role}
    >
      <span
        aria-hidden="true"
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", state.dot)}
      />
      <div className="grid gap-0.5">
        <span className="font-medium">{state.label}</span>
        <span className="text-current/75 text-xs">
          {worker.lastHeartbeatAt ? (
            <>
              Последний сигнал{" "}
              <time dateTime={worker.lastHeartbeatAt}>
                {relativeTime(worker.lastHeartbeatAt)}
              </time>
            </>
          ) : (
            "Сигналов нет. Проверьте запуск worker и доступность базы данных."
          )}
        </span>
      </div>
    </div>
  );
}

/** Fetches the worker pulse independently, so list failures never hide scheduler health. */
export function RoutineWorkerHealthIndicator() {
  const health = useQuery(routineWorkerHealthQueryOptions());

  if (health.isPending) {
    return (
      <p className="mt-4 text-muted-foreground text-sm" role="status">
        Проверяем обработчик расписаний…
      </p>
    );
  }
  if (health.error) {
    return (
      <RoutineWorkerHealthStatus
        worker={{ status: "unavailable", lastHeartbeatAt: null }}
      />
    );
  }
  return <RoutineWorkerHealthStatus worker={health.data} />;
}
