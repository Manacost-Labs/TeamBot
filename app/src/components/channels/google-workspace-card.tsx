import { IconExternalLink, IconFileText, IconTable } from "@tabler/icons-react";
import type { GoogleWorkspaceResult } from "@/lib/google-workspace/result";

export function GoogleWorkspaceCard({
  result,
}: {
  result: GoogleWorkspaceResult;
}) {
  const Icon = result.kind === "document" ? IconFileText : IconTable;
  const product = result.kind === "document" ? "Google Docs" : "Google Sheets";

  return (
    <article
      className="my-2 w-full max-w-md rounded-xl border border-border bg-card p-3 shadow-sm"
      data-testid="google-workspace-card"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-lg bg-primary/10 p-2 text-primary">
          <Icon aria-hidden className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-muted-foreground text-xs">{product}</p>
          <p className="truncate font-medium text-sm">{result.title}</p>
          <p className="mt-1 text-muted-foreground text-sm">{result.status}</p>
          {result.details.map((detail) => (
            <p
              className="mt-0.5 truncate text-muted-foreground text-xs"
              key={detail}
            >
              {detail}
            </p>
          ))}
        </div>
        <a
          aria-label={`Открыть ${result.title}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={result.url}
          rel="noreferrer"
          target="_blank"
        >
          Открыть
          <IconExternalLink aria-hidden className="size-3.5" />
        </a>
      </div>
    </article>
  );
}
