import {
  IconRefresh,
  IconShieldCheck,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";

const roleLabels = {
  admin: "Администратор",
  user: "Участник команды",
} as const;

/**
 * The account context behind every personal connection.
 *
 * This is deliberately read-only. A profile edit endpoint would need its own validation, audit
 * event and session/cache policy; showing the server's current answer first avoids a form that
 * looks authoritative while those rules are still being designed.
 */
export function WorkspaceProfile() {
  const queryClient = useQueryClient();
  const user = useQuery(currentUserQueryOptions());

  if (user.isPending) {
    return (
      <PageSection title="Профиль">
        <PageEmpty>Проверяем данные учётной записи…</PageEmpty>
      </PageSection>
    );
  }

  if (user.isError) {
    return (
      <PageSection title="Профиль">
        <div className="mt-4 flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-5">
          <p className="text-destructive text-sm" role="alert">
            Не удалось загрузить данные учётной записи. Повторите проверку.
          </p>
          <Button
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: authKeys.currentUser(),
              })
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <IconRefresh aria-hidden="true" />
            Повторить
          </Button>
        </div>
      </PageSection>
    );
  }

  if (!user.data) {
    return null;
  }

  const isAdmin = user.data.role === "admin";
  const displayName = user.data.name?.trim() || "Без имени";
  const RoleIcon = isAdmin ? IconShieldCheck : IconUser;

  return (
    <PageSection
      description="Эти данные определяются способом входа и правами рабочего пространства. Секреты подключённых сервисов здесь не показываются."
      title="Профиль"
    >
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <RoleIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{displayName}</ItemTitle>
            <ItemDescription>{user.data.email}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <span className="text-muted-foreground text-xs">
              {roleLabels[user.data.role]}
            </span>
          </ItemActions>
        </Item>
        {isAdmin ? (
          <Item
            render={
              <Link
                aria-label="Открыть управление командой"
                to="/admin/people"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconUsers />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Команда</ItemTitle>
              <ItemDescription>
                Управление доступом и ролями участников.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-xs">Открыть</span>
            </ItemActions>
          </Item>
        ) : null}
      </PageRows>
    </PageSection>
  );
}
