import { IconArrowUpRight, IconChevronDown } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import {
  connectionsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One service, and whether a Bot may read it as you.
 *
 * Its own page rather than a switch on the list, because what a connector needs from a person is not
 * fixed. Drive needs one consent and nothing else; a vendor that scopes access per workspace, or per
 * folder, or asks which of several accounts to use, needs somewhere to ask. This is that somewhere,
 * before there is anything to put in it.
 */
export const Route = createFileRoute(
  "/_authed/settings/connected-accounts/$key",
)({ component: RouteComponent });

function RouteComponent() {
  const { key } = useParams({
    from: "/_authed/settings/connected-accounts/$key",
  });
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const [notice, setNotice] = useState<string | null>(null);

  const connect = useMutation({
    ...connectAccountMutationOptions(),
    onError: (thrown: Error) => setNotice(thrown.message),
    /*
     * A full page navigation, not a fetch. The consent screen is the vendor's own and has to be shown
     * to you in your own browser; there is deliberately nothing here that could complete it for you.
     */
    onSuccess: (authorizationUrl) => {
      window.location.href = authorizationUrl;
    },
  });

  const entry = plugins.data?.catalogue.find((item) => item.key === key);
  const enabled = (plugins.data?.servers ?? []).some((s) => s.id === key);
  const connection = (connections.data?.connections ?? []).find(
    (row) => row.serverId === key,
  );
  const startConnect = () => {
    setNotice(null);
    connect.mutate(key);
  };

  if (plugins.isPending) {
    return <PageShell title="Интеграция">{null}</PageShell>;
  }

  const back = {
    label: "Интеграции",
    linkProps: { to: "/settings/connected-accounts" as const },
  };

  /*
   * A vendor that is not reached as a person has nothing here for anybody to decide, and one an
   * administrator has not enabled cannot be consented to — there is no OAuth client behind it. Both
   * say which it is rather than drawing a switch that cannot work.
   */
  if (entry?.auth !== "user-oauth") {
    return (
      <PageShell
        backButton={back}
        description="Этот сервис не подключается для личного использования."
        title={entry?.title ?? key}
      >
        <PageEmpty>
          {entry
            ? "Сотрудники используют общий доступ приложения, одинаковый для всей команды."
            : "В этом приложении нет такой интеграции."}
        </PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      backButton={back}
      description={entry.summary}
      title={entry.title}
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}

      {/* One decision, so no heading: it would only repeat the row's own title. */}
      <PageSection>
        <PageRows className="mt-0">
          <Item size="sm">
            <ItemContent>
              {/* Not "Подключить аккаунт": the row is also the connected state, and a title has to
                  read for both. */}
              <ItemTitle>Ваш аккаунт</ItemTitle>
              <ItemDescription>
                {!enabled
                  ? "Администратор ещё не включил эту интеграцию, поэтому подключить её пока нельзя."
                  : connection
                    ? "Сотрудник с выданным доступом видит только те данные, которые доступны вам."
                    : "Пока ни один сотрудник не может читать эти данные от вашего имени. Подключение откроет страницу сервиса для подтверждения."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {connection ? (
                /*
                 * A state and a menu, not a switch. Connected is a fact about a grant that lives at
                 * the vendor, and withdrawing it is a deliberate act rather than the other half of a
                 * position — so it is named in a menu instead of being whatever happens when
                 * something slides back.
                 */
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button size="sm" type="button" variant="outline">
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-emerald-500"
                        />
                        Подключено
                        <IconChevronDown />
                      </Button>
                    }
                  />
                  {/*
                   * `w-auto`, because the default is `w-(--anchor-width)` — the width of the trigger,
                   * which here is a small "Connected" button. Left alone, the one item inside wraps
                   * onto three lines and a destructive action becomes hard to read at the moment it
                   * most needs to be legible.
                   */}
                  <DropdownMenuContent align="end" className="w-auto">
                    <DropdownMenuItem
                      disabled={connect.isPending}
                      onClick={startConnect}
                    >
                      Переподключить или изменить доступ
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        /*
                         * NOT BUILT YET, and it says so rather than appearing to work.
                         *
                         * Withdrawing is three acts — revoke at the vendor, revoke the vault
                         * credential, delete the row — and none exist. An item that closed the menu
                         * and changed nothing would report that access had been withdrawn when it
                         * had not, which is the one outcome worse than not offering it.
                         */
                        setNotice(
                          `Отключение из приложения пока не реализовано. Отзовите доступ в настройках сторонних приложений аккаунта ${entry.vendor} — после этого приложение сразу перестанет читать данные.`,
                        )
                      }
                      className="whitespace-nowrap"
                      variant="destructive"
                    >
                      Отключить аккаунт {entry.title}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                /*
                 * The arrow says this leaves OpenBot. It does: the next thing on screen is the
                 * vendor's own consent page, and a control that navigates away should look like one.
                 */
                <Button
                  disabled={!enabled || connect.isPending}
                  onClick={startConnect}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Подключить
                  <IconArrowUpRight />
                </Button>
              )}
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      {connection ? (
        <PageSection
          description="Фактически выданные сервисом разрешения. Они могут отличаться от полного списка запрошенного доступа."
          title="Доступ"
        >
          <PageRows>
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Разрешения</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {connection.scope || "Сервис не указал список разрешений."}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemContent>
                <ItemTitle>Подключено</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-xs">
                  {new Date(connection.connectedAt).toLocaleString()}
                </span>
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
    </PageShell>
  );
}
