import { IconFile, IconRefresh, IconX } from "@tabler/icons-react";
import type { AttachmentDraftItem } from "./attachment-draft";

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function statusText(status: AttachmentDraftItem["status"]): string {
  switch (status) {
    case "queued":
      return "Готов к загрузке";
    case "uploading":
      return "Загрузка…";
    case "ready":
      return "Готово";
    case "failed":
      return "Ошибка загрузки";
  }
}

export function AttachmentTray({
  disabled = false,
  items,
  onRemove,
  onRetry,
}: {
  disabled?: boolean;
  items: readonly AttachmentDraftItem[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <ul
      aria-label="Вложения к сообщению"
      className="flex list-none gap-2 overflow-x-auto px-3 pt-3"
    >
      {items.map((item) => (
        <li
          className="flex min-w-44 max-w-60 items-center gap-2 rounded-lg border border-border bg-muted/30 p-2"
          key={item.localId}
        >
          {item.previewUrl ? (
            <img
              alt={`Предпросмотр ${item.file.name}`}
              className="size-10 shrink-0 rounded object-cover"
              src={item.previewUrl}
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded bg-background"
            >
              <IconFile className="size-5 text-muted-foreground" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs" title={item.file.name}>
              {item.file.name}
            </p>
            <p
              className={
                item.status === "failed"
                  ? "truncate text-destructive text-xs"
                  : "truncate text-muted-foreground text-xs"
              }
              title={item.error ?? undefined}
            >
              <span>{statusText(item.status)}</span> ·{" "}
              {fileSize(item.file.size)}
            </p>
          </div>
          <div className="flex shrink-0 items-center">
            {item.status === "failed" ? (
              <button
                aria-label={`Повторить загрузку ${item.file.name}`}
                className="rounded p-1 text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={disabled}
                onClick={() => onRetry(item.localId)}
                title="Повторить"
                type="button"
              >
                <IconRefresh className="size-4" />
              </button>
            ) : null}
            <button
              aria-label={`Удалить ${item.file.name}`}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={disabled || item.status === "uploading"}
              onClick={() => onRemove(item.localId)}
              type="button"
            >
              <IconX className="size-4" />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
