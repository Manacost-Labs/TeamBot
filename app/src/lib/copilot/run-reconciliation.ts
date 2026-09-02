import type { Message } from "@ag-ui/core";
import { client } from "@/lib/client";

export const RECONCILIATION_DELAYS_MS = [0, 250, 750, 1_500, 3_000] as const;
export const ACTIVE_RECONCILIATION_POLL_MS = 2_000;

export type RunReconciliationEvidence = {
  hasAssistantOutput: boolean;
  runtimeActive: boolean;
};

/**
 * Progress notes explain what a long-running employee is doing, but they are not the result a
 * person asked for. Keeping this classifier beside reconciliation makes the sidebar and the
 * durable-history fallback agree about when a logical request is actually complete.
 */
export function isProgressNote(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  // A progress update is often written as a natural sentence rather than one of the short
  // protocol markers below. Keep these checks deliberately explicit: broad verbs such as
  // "проверяю" also appear in a finished report, while the combinations here describe unfinished
  // work and do not contain a result heading.
  const hasResultSignal =
    /(^|\n)\s*##\s*(результат|источники)\b|\/research-runs\/[^\s`]+\/report\.md\b|(?:отч[её]т|файл|результат)\s+(?:готов|создан|сохранён|сохранен)/iu.test(
      normalized,
    );
  if (hasResultSignal) return false;

  return [
    "начинаю исследование",
    "план зафиксирован",
    "первый проход",
    "сбор углублён",
    "сбор углублен",
    "итоговый проход",
    "продолжаю с",
    "продолжаю сбор",
    "переход к сбору",
    "теперь проверяю",
    "осталось проверить",
    "осталось оформить",
    "параллельно проверяю",
    "источники ещё проверяются",
    "источники еще проверяются",
    "сначала проверю",
    "затем проверю",
    "собираю данные",
    "проверяю конкретные",
    "starting research",
    "plan locked",
    "first pass",
    "deepened collection",
    "final pass",
    "continuing with",
    "continuing collection",
    "moving to collection",
    "now checking",
    "still checking",
    "remaining work",
    "in parallel i am checking",
    "sources are still being checked",
    "first i will check",
    "then i will check",
    "collecting data",
  ].some((marker) => normalized.includes(marker));
}

type ReconciliationOptions = {
  logicalRunId: string;
  readExecution: () => Promise<boolean>;
  readHistory: () => Promise<readonly Message[]>;
  wait?: (milliseconds: number) => Promise<void>;
};

type ReconciliationMonitorOptions = ReconciliationOptions & {
  /** Apply every authoritative observation, including the initial active lock. */
  onEvidence: (evidence: RunReconciliationEvidence) => void;
  /** Keep uncertainty visible while the monitor waits for an authority to recover. */
  onUnavailable: () => void;
  /** Stop when the persisted generation is no longer current or active. */
  stillCurrent: () => boolean;
  pollMilliseconds?: number;
};

const reconciliations = new Map<string, Promise<RunReconciliationEvidence>>();
const monitors = new Map<string, Promise<RunReconciliationEvidence | null>>();

export function hasAssistantOutputAfter(
  messages: readonly Message[],
  userMessageId: string,
): boolean {
  const userIndex = messages.findIndex(
    (message) => message.id === userMessageId,
  );
  if (userIndex < 0) return false;
  return messages.slice(userIndex + 1).some((message) => {
    if (message.role !== "assistant") return false;
    return (
      typeof message.content === "string" &&
      message.content.trim().length > 0 &&
      !isProgressNote(message.content)
    );
  });
}

/**
 * Reconcile a restored run from two independent authorities.
 *
 * A live Intelligence lock proves it is still active. A persisted assistant turn proves it
 * completed even when the browser missed the terminal event. Only repeated, successful answers from
 * both sources may prove failure; transport errors remain uncertainty and are surfaced by the store.
 */
export async function reconcileRunEvidence({
  logicalRunId,
  readExecution,
  readHistory,
  wait = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}: ReconciliationOptions): Promise<RunReconciliationEvidence> {
  let executionKnown = false;
  let historyKnown = false;

  for (const delay of RECONCILIATION_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    const [execution, history] = await Promise.allSettled([
      readExecution(),
      readHistory(),
    ]);
    if (execution.status === "fulfilled") {
      executionKnown = true;
      if (execution.value) {
        return { hasAssistantOutput: false, runtimeActive: true };
      }
    }
    if (history.status === "fulfilled") {
      historyKnown = true;
      if (hasAssistantOutputAfter(history.value, logicalRunId)) {
        return { hasAssistantOutput: true, runtimeActive: false };
      }
    }
  }

  if (!executionKnown || !historyKnown) {
    throw new Error("Run reconciliation authority is temporarily unavailable.");
  }
  return { hasAssistantOutput: false, runtimeActive: false };
}

/** Deduplicate shell/StrictMode effects for the same restored logical generation. */
export function reconcileRunEvidenceOnce(
  key: string,
  options: ReconciliationOptions,
): Promise<RunReconciliationEvidence> {
  const existing = reconciliations.get(key);
  if (existing) return existing;
  const pending = reconcileRunEvidence(options).finally(() => {
    if (reconciliations.get(key) === pending) reconciliations.delete(key);
  });
  reconciliations.set(key, pending);
  return pending;
}

/**
 * Follow a restored run until server lock + durable history provide a terminal answer.
 *
 * There is deliberately no elapsed-time cutoff. A long-running employee is still working however
 * long it takes; the monitor ends only when the authorities say it ended, or when a newer logical
 * generation replaces it. Polling is bounded and sleeps between active/error observations.
 */
export async function monitorRunEvidence({
  logicalRunId,
  readExecution,
  readHistory,
  onEvidence,
  onUnavailable,
  stillCurrent,
  pollMilliseconds = ACTIVE_RECONCILIATION_POLL_MS,
  wait = (milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}: ReconciliationMonitorOptions): Promise<RunReconciliationEvidence | null> {
  while (stillCurrent()) {
    try {
      const evidence = await reconcileRunEvidence({
        logicalRunId,
        readExecution,
        readHistory,
        wait,
      });
      if (!stillCurrent()) return null;
      onEvidence(evidence);
      if (evidence.hasAssistantOutput || !evidence.runtimeActive) {
        return evidence;
      }
    } catch {
      if (!stillCurrent()) return null;
      onUnavailable();
    }
    await wait(pollMilliseconds);
  }
  return null;
}

/** Deduplicate shell/StrictMode monitors for one restored logical generation. */
export function monitorRunEvidenceOnce(
  key: string,
  options: ReconciliationMonitorOptions,
): Promise<RunReconciliationEvidence | null> {
  const existing = monitors.get(key);
  if (existing) return existing;
  const pending = monitorRunEvidence(options).finally(() => {
    if (monitors.get(key) === pending) monitors.delete(key);
  });
  monitors.set(key, pending);
  return pending;
}

export async function readThreadExecution(
  channelId: string,
  threadId: string,
  agentId: string,
): Promise<boolean> {
  const response = await client(
    `/api/threads/${encodeURIComponent(threadId)}/execution?channelId=${encodeURIComponent(channelId)}&agentId=${encodeURIComponent(agentId)}`,
    { fallback: "Не удалось проверить состояние запуска" },
  );
  const body = (await response.json()) as { active?: unknown };
  if (typeof body.active !== "boolean") {
    throw new Error("Сервер вернул неизвестное состояние запуска.");
  }
  return body.active;
}
