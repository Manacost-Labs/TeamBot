import {
  IconAlertCircle,
  IconDownload,
  IconExternalLink,
  IconFileText,
  IconLoader2,
} from "@tabler/icons-react";
import { useEffect, useId, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type ArtifactMetadata,
  artifactDownloadUrl,
  artifactPreviewUrl,
  readArtifactMetadata,
  readMarkdownArtifactPreview,
} from "@/lib/artifacts/api";
import type { ArtifactResult } from "@/lib/artifacts/contract";
import {
  artifactMarkdownComponents,
  artifactMarkdownUrlTransform,
} from "@/lib/markdown";
import {
  abandonArtifactRenderTiming,
  markArtifactCardPainted,
  scheduleAfterPaint,
} from "@/lib/performance/workspace-timing";
import { cn } from "@/lib/utils";

type MetadataState =
  | { status: "loading" }
  | { status: "ready"; value: ArtifactMetadata }
  | { status: "error" };

type PreviewState =
  | { status: "idle" | "loading" }
  | { status: "ready"; markdown: string }
  | { status: "error" };

export function ArtifactCard({
  artifact,
  channelId,
  trackPaint = false,
  toolCallId,
}: {
  artifact: ArtifactResult["artifact"];
  channelId: string;
  trackPaint?: boolean;
  toolCallId: string;
}) {
  const [reload, setReload] = useState(0);
  const [metadata, setMetadata] = useState<MetadataState>({
    status: "loading",
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const previewId = useId();
  const paintRecorded = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload deliberately starts a fresh authenticated request after an error.
  useEffect(() => {
    const controller = new AbortController();
    setMetadata({ status: "loading" });
    void readArtifactMetadata(
      channelId,
      artifact.attachmentId,
      controller.signal,
    )
      .then((value) => setMetadata({ status: "ready", value }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          abandonArtifactRenderTiming(toolCallId);
          setMetadata({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [artifact.attachmentId, channelId, reload, toolCallId]);

  useEffect(() => {
    if (!trackPaint || metadata.status !== "ready" || paintRecorded.current)
      return;
    return scheduleAfterPaint(() => {
      paintRecorded.current = true;
      markArtifactCardPainted(toolCallId);
    });
  }, [metadata.status, toolCallId, trackPaint]);

  const current = metadata.status === "ready" ? metadata.value : null;
  useEffect(() => {
    if (!previewOpen || current?.mimeType !== "text/markdown") return;
    const controller = new AbortController();
    setPreview({ status: "loading" });
    void readMarkdownArtifactPreview(
      channelId,
      artifact.attachmentId,
      controller.signal,
    )
      .then((markdown) => setPreview({ status: "ready", markdown }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setPreview({ status: "error" });
        }
      });
    return () => controller.abort();
  }, [artifact.attachmentId, channelId, current?.mimeType, previewOpen]);

  if (metadata.status === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label={`Загрузка файла ${artifact.title}`}
        className="w-full rounded-lg border border-border bg-muted/20 p-3"
        data-testid="artifact-card"
      >
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      </section>
    );
  }

  if (metadata.status === "error") {
    return (
      <section
        aria-label={artifact.title}
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-muted/20 p-3"
        data-testid="artifact-card"
      >
        <IconAlertCircle className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">{artifact.title}</p>
          <p className="text-muted-foreground text-xs" role="status">
            Файл сейчас недоступен
          </p>
        </div>
        <Button
          onClick={() => setReload((value) => value + 1)}
          size="sm"
          variant="outline"
        >
          Повторить
        </Button>
      </section>
    );
  }

  const ready = metadata.value;
  const downloadUrl = artifactDownloadUrl(channelId, ready.id);
  const previewUrl = artifactPreviewUrl(channelId, ready.id);
  const isPdf = ready.mimeType === "application/pdf";

  return (
    <section
      aria-label={artifact.title}
      className="w-full rounded-lg border border-border bg-muted/20 p-3"
      data-testid="artifact-card"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
          <IconFileText
            aria-hidden="true"
            className="size-5 text-muted-foreground"
          />
        </span>
        <span className="min-w-36 flex-1">
          <span
            className="block truncate font-medium text-sm"
            title={artifact.title}
          >
            {artifact.title}
          </span>
          <span
            className="block truncate text-muted-foreground text-xs"
            title={ready.filename}
          >
            {ready.filename} · {isPdf ? "PDF" : "Markdown"} ·{" "}
            {formatBytes(ready.size)}
          </span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            aria-controls={previewId}
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((open) => !open)}
            size="sm"
            variant="outline"
          >
            {previewOpen ? "Скрыть" : "Предпросмотр"}
          </Button>
          <a
            aria-label={`Скачать ${ready.filename}`}
            className={cn(
              buttonVariants({ size: "icon-sm", variant: "ghost" }),
            )}
            download={ready.filename}
            href={downloadUrl}
            title="Скачать"
          >
            <IconDownload aria-hidden="true" />
          </a>
        </span>
      </div>

      {previewOpen ? (
        <div
          className="mt-3 min-h-48 overflow-auto rounded-lg border border-border bg-background p-3"
          id={previewId}
        >
          {isPdf ? (
            <div className="flex min-h-96 flex-col gap-2">
              <iframe
                className="min-h-96 w-full flex-1 rounded border-0"
                referrerPolicy="no-referrer"
                sandbox=""
                src={previewUrl}
                title={`Предпросмотр ${ready.filename}`}
              />
              <a
                className={cn(
                  buttonVariants({ size: "sm", variant: "outline" }),
                  "self-end",
                )}
                href={previewUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                <IconExternalLink aria-hidden="true" />
                Открыть в новой вкладке
              </a>
            </div>
          ) : preview.status === "ready" ? (
            <div className="min-w-0 overflow-x-auto text-sm">
              <Streamdown
                components={artifactMarkdownComponents}
                mode="static"
                urlTransform={artifactMarkdownUrlTransform}
              >
                {preview.markdown}
              </Streamdown>
            </div>
          ) : preview.status === "error" ? (
            <p className="m-auto text-muted-foreground text-sm" role="status">
              Предпросмотр сейчас недоступен.
            </p>
          ) : (
            <p
              className="m-auto flex items-center gap-2 text-muted-foreground text-sm"
              role="status"
            >
              <IconLoader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              Открываем предпросмотр
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} КБ`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} МБ`;
}
