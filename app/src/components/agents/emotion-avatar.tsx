import { memo } from "react";
import { cn } from "@/lib/utils";

export type EmotionState =
  | "idle"
  | "thinking"
  | "searching"
  | "working"
  | "writing"
  | "happy"
  | "alerting";

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

const SHAPE_PATHS: Record<(typeof SHAPES)[number], string> = {
  arch: "M16 82V43C16 19 31 7 50 7s34 12 34 36v39Z",
  bean: "M23 18C43 2 76 12 82 37c7 29-9 51-38 51C14 88 5 39 23 18Z",
  blob: "M21 17C39 2 72 7 85 31c13 25 3 52-22 60C36 99 8 78 9 49 9 35 11 25 21 17Z",
  capsule:
    "M24 8h52c13 0 20 13 20 42S89 92 76 92H24C11 92 4 79 4 50S11 8 24 8Z",
  cloud:
    "M20 84C1 84-4 57 11 47 5 27 28 13 44 23 56 4 83 18 79 39c25 4 22 45 1 45Z",
  crystal: "M50 3 88 28 80 77 50 97 17 75 11 30Z",
  cylinder: "M13 24C13 4 87 4 87 24v52c0 20-74 20-74 0ZM13 24c0 20 74 20 74 0",
  dome: "M8 89V52C8 23 27 7 50 7s42 16 42 45v37Z",
  egg: "M50 4c20 0 38 30 38 55 0 23-16 37-38 37S12 82 12 59C12 34 30 4 50 4Z",
  gem: "M50 3 86 25 95 58 73 92 33 96 6 64 13 27Z",
  hex: "M27 7h46l23 43-23 43H27L4 50Z",
  leaf: "M91 7C58 9 17 24 10 59 5 85 30 99 54 86 82 71 91 37 91 7Z",
  pebble:
    "M29 8C51 0 83 12 91 36c9 29-8 55-38 59C23 99 5 79 9 48 11 29 14 14 29 8Z",
  shield: "M50 3 90 18v31c0 24-16 39-40 48C26 88 10 73 10 49V18Z",
  squircle:
    "M22 5h56c12 0 17 5 17 17v56c0 12-5 17-17 17H22C10 95 5 90 5 78V22C5 10 10 5 22 5Z",
  tablet:
    "M20 5h60c10 0 15 5 15 15v60c0 10-5 15-15 15H20C10 95 5 90 5 80V20C5 10 10 5 20 5Z",
  teardrop:
    "M50 2C45 17 12 40 12 65c0 20 17 32 38 32s38-12 38-32C88 40 55 17 50 2Z",
  wedge: "M8 10 92 28 78 92 15 82Z",
};

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

/**
 * An inline version of the Grok-emotion coworker.
 *
 * It intentionally uses no iframe or secondary request: ChatGPT's authenticated webview does not
 * forward its navigation credential into nested documents, which turned the old avatar into a
 * broken-document icon. SVG also makes a long channel roster much cheaper than one iframe per row.
 */
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
  const { color, eyes, shape } = emotionAppearance(seed);
  const path =
    SHAPE_PATHS[shape as keyof typeof SHAPE_PATHS] ?? SHAPE_PATHS.blob;

  return (
    <span
      aria-label={`${name}: ${EMOTION_STATE_LABELS[state]}`}
      className={cn("inline-flex shrink-0", className)}
      data-state={state}
      role="img"
      style={{ height: size, width: size }}
    >
      <svg
        aria-hidden="true"
        className="emotion-avatar-svg size-full"
        data-state={state}
        viewBox="0 0 100 100"
      >
        <path className="emotion-avatar-head" d={path} fill={color} />
        <g className="emotion-avatar-eyes" fill={eyes}>
          <ellipse
            className="emotion-avatar-eye"
            cx="36"
            cy="49"
            rx="5.5"
            ry="7"
          />
          <ellipse
            className="emotion-avatar-eye"
            cx="64"
            cy="49"
            rx="5.5"
            ry="7"
          />
        </g>
        <g
          className="emotion-avatar-happy-eyes"
          fill="none"
          stroke={eyes}
          strokeLinecap="round"
          strokeWidth="5"
        >
          <path d="M30 52Q36 43 42 52" />
          <path d="M58 52Q64 43 70 52" />
        </g>
        <circle
          className="emotion-avatar-alert"
          cx="78"
          cy="20"
          fill="#ef4444"
          r="8"
        />
      </svg>
    </span>
  );
});
