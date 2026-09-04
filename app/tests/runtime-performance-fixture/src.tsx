import type { Message } from "@ag-ui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "@/components/channels/chat-transcript";
import "../../src/styles.css";

type Scenario =
  | "cold_switch"
  | "first_delta"
  | "history_50"
  | "history_200"
  | "history_500"
  | "history_2000"
  | "history_10000"
  | "warm_switch";

type BrowserMeasurement = {
  elapsedMs: number;
  markerVisible: boolean;
  mountedRows: number;
};

type BenchmarkApi = {
  showTranscript: (messages: readonly Message[], key?: string) => void;
  peek: (generation: number) => BrowserMeasurement | null;
  prepare: (scenario: Scenario, iteration: number) => number;
  take: (generation: number) => BrowserMeasurement | null;
};

declare global {
  interface Window {
    runtimePerformanceBenchmark?: BenchmarkApi;
  }
}

type ViewState = {
  busy: boolean;
  generation: number;
  key: string;
  marker: string;
  messages: readonly Message[];
};

type PendingMeasurement = {
  generation: number;
  marker: string;
  startedAt: number;
};

type PreparedScenario = {
  generation: number;
  iteration: number;
  scenario: Scenario;
};

const HISTORY_SIZES = [50, 200, 500, 2_000, 10_000] as const;

function artifactId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function markdown(index: number): string {
  return [
    `## Сводка ${index}`,
    "",
    "| Метрика | Значение |",
    "| --- | ---: |",
    `| Конверсия | ${70 + (index % 20)}% |`,
    "",
    "```ts",
    `const batch = ${index};`,
    "```",
    "",
    "Текст с **выделением**, [безопасной ссылкой](https://example.com) и длинным пояснением.",
  ].join("\n");
}

/** Fixed realistic mix: prose, Markdown, attachments, tools, artifacts and Google cards. */
function richHistory(count: number, prefix: string): readonly Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const variant = index % 12;
    const id = `${prefix}-${index}`;
    if (variant === 2) {
      messages.push({
        id,
        role: "user",
        content: [
          { type: "text", text: `Проверь вложение ${index}` },
          {
            type: "binary",
            id: `attachment-${prefix}-${index}`,
            mimeType: "image/png",
            filename: `screen-${index}.png`,
          },
        ],
      });
      continue;
    }
    if (variant === 4) {
      messages.push({
        id,
        role: "assistant",
        toolCalls: [
          {
            id: `google-call-${prefix}-${index}`,
            type: "function",
            function: {
              arguments: JSON.stringify({ title: `План ${index}` }),
              name: "mcp__google-drive__create_google_doc",
            },
          },
        ],
      });
      continue;
    }
    if (variant === 5) {
      messages.push({
        id,
        role: "tool",
        toolCallId: `google-call-${prefix}-${index - 1}`,
        content: `Created Google Doc: [План ${index}](https://docs.google.com/document/d/doc_${index}/edit)\n2 раздела`,
      });
      continue;
    }
    if (variant === 7) {
      const attachmentId = artifactId(index);
      messages.push({
        id,
        role: "assistant",
        toolCalls: [
          {
            id: `artifact-call-${prefix}-${index}`,
            type: "function",
            function: {
              arguments: JSON.stringify({ filename: `report-${index}.md` }),
              name: "mcp__artifacts__create_artifact",
            },
          },
        ],
      });
      messages.push({
        id: `${id}-result`,
        role: "tool",
        toolCallId: `artifact-call-${prefix}-${index}`,
        content: JSON.stringify({
          schema: "openbot.artifact.v1",
          artifact: {
            attachmentId,
            filename: `report-${index}.md`,
            mimeType: "text/markdown",
            size: 2048 + index,
            title: `Отчёт ${index}`,
          },
        }),
      });
      index += 1;
      continue;
    }
    messages.push({
      id,
      role: variant % 3 === 0 ? "user" : "assistant",
      content: markdown(index),
    });
  }

  const exact = messages.slice(0, count - 1);
  exact.push({
    id: `${prefix}-marker`,
    role: "assistant",
    content: `PERF-MARKER ${prefix}`,
  });
  return exact;
}

const histories = new Map<number, readonly Message[]>(
  HISTORY_SIZES.map((size) => [size, richHistory(size, `history-${size}`)]),
);
const warmHistories = [
  richHistory(200, "warm-a"),
  richHistory(200, "warm-b"),
] as const;
const coldHistory = richHistory(200, "cold");
const firstDeltaBase = richHistory(50, "delta-base").slice(0, -1);

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const requestUrl = new URL(
    input instanceof Request ? input.url : String(input),
    globalThis.location.href,
  );
  const match = /^\/api\/channels\/[^/]+\/attachments\/([0-9a-f-]+)$/.exec(
    requestUrl.pathname,
  );
  if (!match) return nativeFetch(input, init);
  const id = match[1] ?? "";
  return Response.json({
    attachment: {
      id,
      filename: `report-${id.slice(-4)}.md`,
      messageId: `artifact:${id}`,
      mimeType: "text/markdown",
      size: 4096,
      source: "agent_generated",
    },
  });
};

function historyFor(size: number): readonly Message[] {
  const value = histories.get(size);
  if (!value) throw new Error(`Unsupported history size: ${size}`);
  return value;
}

function RuntimePerformanceFixture() {
  const [view, setView] = useState<ViewState>(() => ({
    busy: false,
    generation: 0,
    key: "initial",
    marker: "PERF-MARKER initial",
    messages: richHistory(50, "initial"),
  }));
  const pending = useRef<PendingMeasurement | null>(null);
  const measurements = useRef(new Map<number, BrowserMeasurement>());
  const nextGeneration = useRef(1);
  const prepared = useRef<PreparedScenario | null>(null);

  const commit = useCallback((next: Omit<ViewState, "generation">): number => {
    if (pending.current) {
      throw new Error(
        "A benchmark transition was started before the previous paint",
      );
    }
    const generation = nextGeneration.current;
    nextGeneration.current += 1;
    pending.current = {
      generation,
      marker: next.marker,
      startedAt: performance.now(),
    };
    setView({ ...next, generation });
    return generation;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation deliberately starts a paint measurement after each requested commit.
  useEffect(() => {
    const measurement = pending.current;
    if (!measurement) return;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (pending.current !== measurement) return;
        pending.current = null;
        const markerVisible = document.body.textContent?.includes(
          measurement.marker,
        );
        measurements.current.set(measurement.generation, {
          elapsedMs:
            Math.round((performance.now() - measurement.startedAt) * 1_000) /
            1_000,
          markerVisible: markerVisible === true,
          mountedRows: document.querySelectorAll("[data-transcript-window-row]")
            .length,
        });
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [view.generation]);

  const start = useCallback<(scenario: Scenario, iteration: number) => number>(
    (scenario, iteration) => {
      if (scenario === "warm_switch") {
        const slot =
          ((iteration % warmHistories.length) + warmHistories.length) %
          warmHistories.length;
        const marker = `PERF-MARKER warm-${slot === 0 ? "a" : "b"}`;
        return commit({
          busy: false,
          key: `warm-${slot === 0 ? "a" : "b"}`,
          marker,
          messages: warmHistories[slot],
        });
      }
      if (scenario === "cold_switch") {
        return commit({
          busy: false,
          key: `cold-${iteration}`,
          marker: "PERF-MARKER cold",
          messages: coldHistory,
        });
      }
      if (scenario === "first_delta") {
        const marker = `FIRST-DELTA-${iteration}`;
        return commit({
          busy: true,
          key: `first-delta-${iteration}`,
          marker,
          messages: [
            ...firstDeltaBase,
            {
              id: `first-delta-message-${iteration}`,
              role: "assistant",
              content: marker,
            },
          ],
        });
      }
      const size = Number.parseInt(scenario.slice("history_".length), 10);
      return commit({
        busy: false,
        key: `${scenario}-${iteration}`,
        marker: `PERF-MARKER history-${size}`,
        messages: historyFor(size),
      });
    },
    [commit],
  );

  useEffect(() => {
    globalThis.runtimePerformanceBenchmark = {
      showTranscript: (messages, key) => {
        setView((previous) => ({
          ...previous,
          key: key ?? previous.key,
          messages,
          busy: false,
        }));
      },
      peek: (generation) => measurements.current.get(generation) ?? null,
      prepare: (scenario, iteration) => {
        if (prepared.current || pending.current) {
          throw new Error("A benchmark transition is already pending");
        }
        const generation = nextGeneration.current;
        prepared.current = { generation, iteration, scenario };
        return generation;
      },
      take: (generation) => {
        const measurement = measurements.current.get(generation) ?? null;
        measurements.current.delete(generation);
        return measurement;
      },
    };
    return () => {
      delete globalThis.runtimePerformanceBenchmark;
    };
  }, []);

  return (
    <div className="h-screen bg-background text-foreground">
      <button
        aria-label="Запустить подготовленный performance transition"
        className="fixed top-0 left-0 z-50 size-4 opacity-[0.01]"
        data-runtime-performance-trigger=""
        onClick={() => {
          const request = prepared.current;
          if (!request) throw new Error("No benchmark transition was prepared");
          prepared.current = null;
          const generation = start(request.scenario, request.iteration);
          if (generation !== request.generation) {
            throw new Error("Benchmark generation changed before click");
          }
        }}
        type="button"
      />
      <ChatTranscript
        busy={view.busy}
        channelId={view.key}
        conversationKey={view.key}
        key={view.key}
        messages={view.messages}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Runtime performance fixture root is missing");
createRoot(root).render(<RuntimePerformanceFixture />);
