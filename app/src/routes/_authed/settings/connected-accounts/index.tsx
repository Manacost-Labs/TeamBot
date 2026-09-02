import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconChevronRight,
  IconPlug,
  IconRefresh,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RowMark } from "@/components/layout/row-mark";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  connectionsQueryOptions,
  pluginKeys,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { cn } from "@/lib/utils";

/**
 * The services a Bot reads as you.
 *
 * Yours, not the deployment's. An administrator decides which vendors this deployment may reach at
 * all; this is the other half of that decision, and it is one nobody can make for you — there is no
 * endpoint for an administrator to connect an account on somebody's behalf. A Bot calling one of
 * these runs on your own grant, so it sees exactly what you can see and nothing else.
 */
export const Route = createFileRoute("/_authed/settings/connected-accounts/")({
  component: RouteComponent,
  /*
   * `?connected=` is how the OAuth callback reports back, carrying a server key on success and
   * `failed` otherwise. It is the only channel available: the callback is a redirect from another
   * company's server, so there is no response body to read.
   *
   * The key is omitted rather than set to undefined. Present-but-undefined makes `search` a required
   * prop on every Link to this route, which is a lot of ripple for a parameter only the callback sets.
   */
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === "string" ? { connected: search.connected } : {},
});

/** The same marks the admin connector list uses: these are the same vendors seen from your side. */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

function RouteComponent() {
  const { connected: outcome } = Route.useSearch();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const refreshing = plugins.isFetching || connections.isFetching;

  const refresh = () => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: pluginKeys.page() }),
      queryClient.invalidateQueries({ queryKey: pluginKeys.connections() }),
    ]);
  };

  const connected = new Set(
    (connections.data?.connections ?? []).map((row) => row.serverId),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));

  /*
   * Only vendors reached as a person, and only ones an administrator has enabled.
   *
   * A vendor with a shared token has nothing for you to decide: it answers the same for everybody,
   * so listing it here would offer a choice you do not have. And a vendor nobody has enabled cannot
   * be connected at all, because there is no OAuth client to consent against.
   */
  const yours = (plugins.data?.catalogue ?? []).filter(
    (entry) => entry.auth === "user-oauth" && added.has(entry.key),
  );

  return (
    <PageShell
      action={
        <Button
          aria-label="Обновить интеграции"
          disabled={refreshing}
          onClick={refresh}
          size="sm"
          type="button"
          variant="outline"
        >
          <IconRefresh className={cn({ "animate-spin": refreshing })} />
          Обновить
        </Button>
      }
      description="Интеграции, которые сотрудники используют от вашего имени. Они видят только те данные, к которым у вас есть доступ."
      title="Интеграции"
    >
      {/*
       * Only the failure is worth saying. A success needs no sentence: the row it came back to now
       * reads "Connected", which is the same news told by the thing it is news about.
       */}
      {outcome === "failed" ? (
        <p className="text-destructive text-sm" role="alert">
          Не удалось подключить аккаунт. Ничего не сохранено — попробуйте ещё
          раз.
        </p>
      ) : null}
      {plugins.isPending || connections.isPending ? (
        <PageSection>
          <PageEmpty>Проверяем доступные интеграции…</PageEmpty>
        </PageSection>
      ) : plugins.error || connections.error ? (
        <PageSection>
          <div className="mt-4 flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-5">
            <p className="text-destructive text-sm" role="alert">
              Не удалось загрузить интеграции. Повторите проверку.
            </p>
            <Button
              disabled={refreshing}
              onClick={refresh}
              size="sm"
              type="button"
              variant="outline"
            >
              <IconRefresh aria-hidden="true" />
              Повторить
            </Button>
          </div>
        </PageSection>
      ) : (
        <PageSection>
          {yours.length === 0 ? (
            /*
             * Says whose move it is. "Nothing here" on its own reads as though you failed to do
             * something, when what is missing is an administrator enabling a connector.
             */
            <PageEmpty>
              Пока нет доступных интеграций. Они появятся, когда администратор
              включит сервис, работающий от вашего имени.
            </PageEmpty>
          ) : (
            <PageRows>
              {yours.map((entry, index) => {
                const Mark = markFor(entry.key);
                return (
                  <React.Fragment key={entry.key}>
                    {/* A real link with no children: children passed to `render` replace the row's own. */}
                    <Item
                      data-testid={`account-${entry.key}`}
                      render={
                        <Link
                          params={{ key: entry.key }}
                          to="/settings/connected-accounts/$key"
                        />
                      }
                      size="sm"
                    >
                      <RowMark>
                        <Mark className="size-4" />
                      </RowMark>
                      <ItemContent>
                        <ItemTitle>{entry.title}</ItemTitle>
                        <ItemDescription>{entry.summary}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {/*
                         * A dot, so connected is legible without reading. Two states that differ only
                         * by the word "not" are two states somebody has to read carefully to tell
                         * apart, which is the wrong amount of effort for the only fact this row
                         * carries. The same green as the account page's own control, so the list and
                         * the page it opens agree at a glance.
                         *
                         * Decorative: the text beside it already says which, so a screen reader that
                         * announced the dot as well would say it twice.
                         */}
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-1.5 rounded-full",
                            connected.has(entry.key)
                              ? "bg-emerald-500"
                              : "bg-muted-foreground/40",
                          )}
                        />
                        <span className="text-muted-foreground text-xs">
                          {connected.has(entry.key)
                            ? "Подключено"
                            : "Не подключено"}
                        </span>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </ItemActions>
                    </Item>
                    {index !== yours.length - 1 && <Separator />}
                  </React.Fragment>
                );
              })}
            </PageRows>
          )}
        </PageSection>
      )}
    </PageShell>
  );
}
