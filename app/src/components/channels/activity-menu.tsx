import {
  IconActivity,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconLoader2,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentRunStatusLabel,
  formatElapsedMs,
  isAgentRunActive,
  type AgentRunState,
} from "@/lib/copilot/run-state";
import { activitySnapshotFor, type VisibleChatItem } from "./chat-messages";

function toolsLabel(count: number): string {
  if (count === 0) return "Без инструментов";
  if (count === 1) return "1 инструмент";
  return `${count} инструментов`;
}

/** A compact, persistent overview of the current and last task in a chat. */
export function ActivityMenu({
  busy = false,
  items,
  onRetry,
  run,
  stopped,
}: {
  busy?: boolean;
  items: readonly VisibleChatItem[];
  /** Explicit lifecycle state; transcript inference remains as a fallback for older callers. */
  run?: AgentRunState;
  stopped?: string;
  onRetry?: () => void;
}) {
  const snapshot = useMemo(
    () => activitySnapshotFor(items, busy, stopped, run),
    [busy, items, run, stopped],
  );
  const [open, setOpen] = useState(() => busy);
  const wasBusy = useRef(busy);
  const [now, setNow] = useState(() => Date.now());

  // One low-frequency clock for the open panel. Tokens do not schedule timers and a completed
  // report keeps its final duration, which avoids a render storm in long research runs.
  useEffect(() => {
    if (!run?.startedAt || (!busy && !isAgentRunActive(run.status))) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [busy, run?.startedAt, run?.status]);

  const elapsedMs =
    run?.startedAt && (busy || isAgentRunActive(run.status))
      ? Math.max(run.elapsedMs, now - run.startedAt)
      : snapshot.elapsedMs;

  // Re-open only when a new task starts; a person's deliberate collapse is respected while it runs.
  useEffect(() => {
    if (busy && !wasBusy.current) setOpen(true);
    wasBusy.current = busy;
  }, [busy]);

  return (
    <div
      aria-busy={snapshot.status === "working"}
      className="activity-menu-shell"
      data-status={snapshot.status}
      {...(snapshot.runStatus ? { "data-run-status": snapshot.runStatus } : {})}
      data-testid="activity-menu"
    >
      <details
        className="activity-menu"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
      >
        <summary className="activity-menu-summary">
          <span className="activity-menu-icon" aria-hidden="true">
            <IconActivity className="size-4" />
          </span>
          <span className="activity-menu-copy">
            <span className="activity-menu-title">Активность</span>
            <span className="activity-menu-label" role="status">
              {snapshot.label}
            </span>
          </span>
            <span className="activity-menu-status">{snapshot.statusLabel}</span>
          <IconChevronDown
            aria-hidden="true"
            className="activity-menu-chevron size-4"
          />
        </summary>
        <div className="activity-menu-body">
          {snapshot.steps.length > 0 ? (
            <ol
              aria-label="Этапы последнего запроса"
              className="activity-menu-steps"
            >
              {snapshot.steps.map((step) => (
                <li
                  className="activity-menu-step"
                  data-state={step.state}
                  key={step.id}
                >
                  <span aria-hidden="true" className="activity-menu-step-icon">
                    {step.state === "active" ? (
                      <IconLoader2 className="size-3.5 activity-menu-spin" />
                    ) : step.state === "warning" ? (
                      <IconAlertTriangle className="size-3.5" />
                    ) : (
                      <IconCheck className="size-3.5" />
                    )}
                  </span>
                  <span>{step.label}</span>
                  <span className="activity-menu-step-state">
                    {step.state === "active"
                      ? "сейчас"
                      : step.state === "warning"
                        ? "нужно проверить"
                        : "готово"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="activity-menu-empty">
              Отправьте задачу — здесь появятся её этапы.
            </p>
          )}
          <div className="activity-menu-meta">
            <span>{toolsLabel(snapshot.toolCount)}</span>
            <span>
              {snapshot.status === "working"
                ? `${agentRunStatusLabel(snapshot.runStatus ?? "thinking")} · ${formatElapsedMs(elapsedMs)}`
                : run?.finishedAt
                  ? `Время работы · ${formatElapsedMs(elapsedMs)}`
                : "История сохраняется в чате"}
            </span>
            {run?.status === "failed" && onRetry ? (
              <button
                className="rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={onRetry}
                type="button"
              >
                Повторить
              </button>
            ) : null}
          </div>
        </div>
      </details>
    </div>
  );
}
