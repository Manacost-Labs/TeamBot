import { createFileRoute } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   *
   * Connected accounts used to be a section below. It is its own screen now: a connector can need
   * more from a person than one switch, and a section cannot grow a page's worth of that.
   */
  return (
    <PageShell
      description="Настройки внешнего вида и поведения приложения для вашей учётной записи."
      title="Настройки"
    >
      <PageSection title="Основные">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Тёмная тема</ItemTitle>
              <ItemDescription>
                Использовать тёмное оформление во всём приложении.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Тёмная тема"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
