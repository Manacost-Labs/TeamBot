import { IconFileText, IconRefresh, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { ArtifactCard } from "@/components/channels/artifact-card";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type WorkspaceArtifactMetadata,
  workspaceArtifactsQueryOptions,
} from "@/lib/artifacts/api";
import type {
  ArtifactMimeType,
  ArtifactResult,
} from "@/lib/artifacts/contract";
import { channelListQueryOptions } from "@/lib/channels/queries";

export const Route = createFileRoute("/_authed/_app/results")({
  component: ResultsPage,
});

type ArtifactFilter = "all" | ArtifactMimeType;

const FILTERS: ReadonlyArray<{ value: ArtifactFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "text/markdown", label: "Markdown" },
  { value: "text/plain", label: "Текст" },
  { value: "application/pdf", label: "PDF" },
  { value: "application/json", label: "JSON" },
  { value: "text/csv", label: "CSV" },
];

export function filterWorkspaceArtifacts(
  artifacts: readonly WorkspaceArtifactMetadata[],
  filter: ArtifactFilter,
  search: string,
): WorkspaceArtifactMetadata[] {
  const needle = search.trim().toLocaleLowerCase();
  return artifacts.filter((artifact) => {
    if (filter !== "all" && artifact.mimeType !== filter) return false;
    if (!needle) return true;
    return artifact.filename.toLocaleLowerCase().includes(needle);
  });
}

function ResultsPage() {
  const results = useInfiniteQuery(workspaceArtifactsQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [search, setSearch] = useState("");

  const artifacts = results.data?.pages.flatMap((page) => page.artifacts) ?? [];
  const visibleArtifacts = filterWorkspaceArtifacts(artifacts, filter, search);
  const channelNames = useMemo(
    () =>
      new Map(
        (channels.data ?? []).map((channel) => [channel.id, channel.name]),
      ),
    [channels.data],
  );

  return (
    <PageShell
      description="Файлы, которые сотрудники создали в ваших диалогах. Откройте предпросмотр или скачайте нужный результат."
      title="Результаты"
      width="wide"
    >
      <PageSection>
        {results.isPending ? (
          <ResultsLoading />
        ) : results.isError ? (
          <ResultsError onRetry={() => void results.refetch()} />
        ) : (
          <>
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <label className="sr-only" htmlFor="results-search">
                  Поиск по имени файла
                </label>
                <IconSearch
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Поиск по имени файла"
                  className="pl-8"
                  id="results-search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Поиск по имени файла"
                  value={search}
                />
              </div>
              <fieldset className="flex flex-wrap gap-1">
                <legend className="sr-only">Тип файла</legend>
                {FILTERS.map((option) => (
                  <Button
                    aria-pressed={filter === option.value}
                    key={option.value}
                    onClick={() => setFilter(option.value)}
                    size="sm"
                    type="button"
                    variant={filter === option.value ? "default" : "outline"}
                  >
                    {option.label}
                  </Button>
                ))}
              </fieldset>
            </div>

            {visibleArtifacts.length === 0 ? (
              <PageEmpty>
                {artifacts.length === 0
                  ? "Здесь появятся Markdown и другие файлы, созданные сотрудниками."
                  : "По выбранному фильтру файлов не найдено."}
              </PageEmpty>
            ) : (
              <div className="mt-4 grid gap-3">
                {visibleArtifacts.map((artifact) => (
                  <ResultRow
                    artifact={artifact}
                    channelName={
                      channelNames.get(artifact.channelId) ?? "Диалог"
                    }
                    key={artifact.id}
                  />
                ))}
              </div>
            )}

            {results.hasNextPage ? (
              <div className="mt-5 flex justify-center">
                <Button
                  disabled={results.isFetchingNextPage}
                  onClick={() => void results.fetchNextPage()}
                  type="button"
                  variant="outline"
                >
                  {results.isFetchingNextPage ? "Загружаем…" : "Загрузить ещё"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </PageSection>
    </PageShell>
  );
}

function ResultRow({
  artifact,
  channelName,
}: {
  artifact: WorkspaceArtifactMetadata;
  channelName: string;
}) {
  const artifactResult: ArtifactResult["artifact"] = {
    attachmentId: artifact.id,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    size: artifact.size,
    title: artifact.filename,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 px-1 text-xs text-muted-foreground">
        <IconFileText aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{channelName}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={artifact.createdAt}>
          {formatResultDate(artifact.createdAt)}
        </time>
      </div>
      <ArtifactCard
        artifact={artifactResult}
        channelId={artifact.channelId}
        toolCallId={`results:${artifact.id}`}
      />
    </div>
  );
}

function ResultsLoading() {
  return (
    <div aria-busy="true" className="grid gap-3" data-testid="results-loading">
      {[0, 1, 2].map((item) => (
        <div
          className="h-24 animate-pulse rounded-lg border border-border bg-muted/20"
          key={item}
        />
      ))}
    </div>
  );
}

function ResultsError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-5">
      <p className="text-sm text-destructive" role="alert">
        Не удалось загрузить результаты.
      </p>
      <Button onClick={onRetry} size="sm" type="button" variant="outline">
        <IconRefresh aria-hidden="true" />
        Повторить
      </Button>
    </div>
  );
}

function formatResultDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Дата неизвестна";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
