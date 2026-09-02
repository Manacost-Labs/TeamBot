import { IconCheck, IconCopy, IconExternalLink } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  issueEmbedApiTokenMutationOptions,
  revokeEmbedApiTokenMutationOptions,
} from "@/lib/agents/mutations";

/**
 * The owner-facing controls for the site API.
 *
 * The raw credential is intentionally local state only: the server returns it once and stores only
 * its hash. A refresh, navigation or rotation removes it from this screen.
 */
export function EmbedApiPanel({
  agentId,
  hasToken = false,
}: {
  agentId: string;
  hasToken?: boolean;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const issue = useMutation(issueEmbedApiTokenMutationOptions(queryClient));
  const revoke = useMutation(revokeEmbedApiTokenMutationOptions(queryClient));

  const endpoint =
    typeof window === "undefined"
      ? `/api/copilotkit/agent/${encodeURIComponent(agentId)}/run`
      : `${window.location.origin}/api/copilotkit/agent/${encodeURIComponent(agentId)}/run`;

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium text-sm">Встраивание на сайт</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Сайт может отправлять сообщения этому сотруднику через защищённый
          AG-UI API. Токен даёт доступ только к этому сотруднику и показывается
          один раз.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">Endpoint</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs">
            {endpoint}
          </code>
          <Button
            aria-label="Скопировать endpoint"
            onClick={() => void copy(endpoint)}
            size="icon"
            variant="ghost"
          >
            {copied ? <IconCheck /> : <IconCopy />}
          </Button>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        Передавайте токен в заголовке <code>x-manacost-embed-token</code>. Ответ
        приходит потоком событий AG-UI (SSE), поэтому его можно подключить к
        готовому клиенту AG-UI на вашем сайте.
      </p>

      {token ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="font-medium text-sm">Скопируйте токен сейчас</p>
          <code className="block break-all rounded-md bg-background p-2 text-xs">
            {token}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy(token)} size="sm">
              <IconCopy /> Скопировать токен
            </Button>
            <Button onClick={() => setToken(null)} size="sm" variant="outline">
              Готово
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            После закрытия этого сообщения токен нельзя будет восстановить.
          </p>
        </div>
      ) : null}

      <Separator />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={issue.isPending}
          onClick={async () => {
            const next = await issue.mutateAsync(agentId);
            setToken(next);
          }}
          size="sm"
        >
          <IconExternalLink />
          {issue.isPending
            ? "Выпускаем…"
            : hasToken
              ? "Выпустить новый токен"
              : "Выпустить токен"}
        </Button>
        {hasToken ? (
          <Button
            disabled={revoke.isPending}
            onClick={() => void revoke.mutateAsync(agentId)}
            size="sm"
            variant="outline"
          >
            {revoke.isPending ? "Отзываем…" : "Отозвать доступ"}
          </Button>
        ) : null}
      </div>
      {issue.error || revoke.error ? (
        <p className="text-destructive text-sm" role="alert">
          {(issue.error ?? revoke.error)?.message}
        </p>
      ) : null}
    </section>
  );
}
