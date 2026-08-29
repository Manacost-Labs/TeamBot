import { memo, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type EmotionState =
  | "idle"
  | "thinking"
  | "searching"
  | "working"
  | "writing"
  | "happy"
  | "alerting";

type EmotionConfig = {
  state: EmotionState;
  shape: string;
  color: string;
  eyes: string;
  size: number;
  autoCycle: boolean;
};

type EmotionController = {
  iframe: HTMLIFrameElement;
  update(config: Partial<EmotionConfig>): EmotionController;
  destroy(): void;
};

type GrokEmotionApi = {
  mount(target: HTMLElement, config: EmotionConfig): EmotionController;
};

declare global {
  interface Window {
    GrokEmotion?: GrokEmotionApi;
  }
}

const SCRIPT_ID = "grok-emotion-embed";
const SCRIPT_SRC = "/grok-emotion/embed.js";
const SCRIPT_BASE = "/grok-emotion";

const SHAPES = [
  "blob",
  "pebble",
  "bean",
  "egg",
  "squircle",
  "tablet",
  "capsule",
  "cylinder",
  "hex",
  "gem",
  "crystal",
  "wedge",
  "shield",
  "dome",
  "arch",
  "cloud",
  "teardrop",
  "leaf",
] as const;

const PALETTES = [
  { color: "#f4f4f4", eyes: "#0a0a0a" },
  { color: "#946b43", eyes: "#0a0a0a" },
  { color: "#dc2942", eyes: "#0a0a0a" },
  { color: "#ee6200", eyes: "#0a0a0a" },
  { color: "#f39a08", eyes: "#0a0a0a" },
  { color: "#08a96f", eyes: "#08110d" },
  { color: "#11a99f", eyes: "#07100f" },
  { color: "#2f80ed", eyes: "#07101c" },
  { color: "#7042d6", eyes: "#ffffff" },
  { color: "#dc3188", eyes: "#16040d" },
  { color: "#b7b7b7", eyes: "#0a0a0a" },
] as const;

export const EMOTION_STATE_LABELS: Record<EmotionState, string> = {
  alerting: "ошибка",
  happy: "задача завершена",
  idle: "готов к работе",
  searching: "ищет информацию",
  thinking: "думает",
  working: "работает",
  writing: "пишет ответ",
};

function hash(seed: string): number {
  let value = 2_166_136_261;
  for (const character of seed) {
    value ^= character.codePointAt(0) ?? 0;
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

export function emotionAppearance(seed: string): {
  color: string;
  eyes: string;
  shape: string;
} {
  const value = hash(seed);
  const palette = PALETTES[value % PALETTES.length] ?? PALETTES[0];
  return {
    color: palette.color,
    eyes: palette.eyes,
    shape:
      SHAPES[Math.floor(value / PALETTES.length) % SHAPES.length] ?? "blob",
  };
}

let scriptPromise: Promise<GrokEmotionApi> | null = null;

function loadEmotionEngine(): Promise<GrokEmotionApi> {
  if (window.GrokEmotion) return Promise.resolve(window.GrokEmotion);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<GrokEmotionApi>((resolve, reject) => {
    const existing = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.dataset.base = SCRIPT_BASE;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        if (window.GrokEmotion) resolve(window.GrokEmotion);
        else reject(new Error("Движок аватара не инициализирован."));
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("Не удалось загрузить аватар.")),
      {
        once: true,
      },
    );
    if (!existing) document.head.append(script);
  });

  return scriptPromise;
}

export const EmotionAvatar = memo(function EmotionAvatar({
  className,
  name,
  seed,
  size = 72,
  state = "idle",
}: {
  className?: string;
  name: string;
  seed: string;
  size?: number;
  state?: EmotionState;
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<EmotionController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [failed, setFailed] = useState(false);
  const { color, eyes, shape } = emotionAppearance(seed);

  useEffect(() => {
    let active = true;
    const target = containerRef.current;
    if (!target) return;

    void loadEmotionEngine()
      .then((engine) => {
        if (!active) return;
        const controller = engine.mount(target, {
          autoCycle: false,
          color,
          eyes,
          shape,
          size,
          state: stateRef.current,
        });
        controller.iframe.title = `Анимированный аватар сотрудника ${name}`;
        controller.iframe.tabIndex = -1;
        controller.iframe.setAttribute("aria-hidden", "true");
        controllerRef.current = controller;
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [color, eyes, name, shape, size]);

  useEffect(() => {
    controllerRef.current?.update({ state });
  }, [state]);

  return (
    <span
      aria-label={`${name}: ${EMOTION_STATE_LABELS[state]}`}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        className,
      )}
      role="img"
      style={{ height: size, width: size }}
    >
      <span aria-hidden="true" className="size-full" ref={containerRef} />
      {failed ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 grid place-items-center rounded-full bg-muted font-semibold text-foreground"
        >
          {name.trim().slice(0, 1).toLocaleUpperCase("ru-RU")}
        </span>
      ) : null}
    </span>
  );
});
