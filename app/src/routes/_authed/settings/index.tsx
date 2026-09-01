import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  type AiConnectionMutationError,
  connectOpenRouterMutationOptions,
  disconnectPersonalAiMutationOptions,
} from "@/lib/ai-connections/mutations";
import { personalAiConnectionQueryOptions } from "@/lib/ai-connections/queries";

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
      <OpenRouterSettingsCard />
    </PageShell>
  );
}

function connectFailure(error: AiConnectionMutationError | null) {
  switch (error?.reason) {
    case "invalid-key":
      return "Ключ OpenRouter не прошёл проверку. Проверьте ключ и попробуйте снова.";
    case "rate-limited":
      return "OpenRouter временно ограничил проверку ключей. Попробуйте немного позже.";
    case "not-authorized":
      return "Сессия больше не позволяет менять подключение. Обновите страницу и войдите снова.";
    case "invalid-response":
    case "unavailable":
      return "Не удалось проверить ключ OpenRouter. Ничего не сохранено — попробуйте позже.";
    default:
      return null;
  }
}

export function OpenRouterSettingsCard() {
  const queryClient = useQueryClient();
  const keyInput = useRef<HTMLInputElement>(null);
  const connection = useQuery(personalAiConnectionQueryOptions());
  const takeApiKey = () => {
    const input = keyInput.current;
    if (!input) return "";
    const value = input.value.trim();
    input.value = "";
    return value;
  };
  const connect = useMutation(
    connectOpenRouterMutationOptions(queryClient, takeApiKey),
  );
  const disconnect = useMutation(
    disconnectPersonalAiMutationOptions(queryClient),
  );
  const active = connection.data?.state === "active";
  const openRouterActive = active && connection.data?.provider === "openrouter";
  const replacing = connect.isPending && active;

  useEffect(() => {
    const input = keyInput.current;
    return () => {
      if (input) input.value = "";
    };
  }, []);

  let status = "OpenRouter не подключён";
  if (connection.isPending) status = "Проверяем подключение…";
  else if (connection.isError) status = "Не удалось проверить подключение";
  else if (replacing) status = "Заменяем ключ OpenRouter…";
  else if (connect.isPending) status = "Проверяем ключ OpenRouter…";
  else if (disconnect.isPending) status = "Отключаем OpenRouter…";
  else if (openRouterActive) status = "OpenRouter подключён";
  else if (active && connection.data?.provider === "chatgpt") {
    status = "Сейчас подключён ChatGPT / Codex";
  }

  const error =
    connectFailure(connect.error) ??
    (disconnect.isError
      ? "Не удалось отключить OpenRouter. Попробуйте ещё раз."
      : null);
  const busy = connect.isPending || disconnect.isPending;

  return (
    <PageSection
      description="Ваш личный ключ проверяется OpenRouter и сохраняется в зашифрованном виде. После отправки увидеть его снова нельзя."
      title="Доступ к AI"
    >
      <PageRows>
        <div className="p-4">
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-sm">OpenRouter</h3>
            <p
              aria-live="polite"
              className="text-muted-foreground text-sm"
              role="status"
            >
              {status}
            </p>
            {active && connection.data?.provider === "chatgpt" ? (
              <p className="text-muted-foreground text-xs">
                Новый ключ заменит текущее подключение ChatGPT / Codex.
              </p>
            ) : null}
          </div>

          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              connect.mutate();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="openrouter-api-key">Ключ OpenRouter</Label>
              <Input
                aria-describedby="openrouter-key-help"
                aria-invalid={connect.isError}
                autoCapitalize="none"
                autoComplete="off"
                disabled={busy}
                id="openrouter-api-key"
                name="openrouter-api-key"
                onInput={() => connect.reset()}
                placeholder="Вставьте новый API-ключ"
                ref={keyInput}
                required
                spellCheck={false}
                type="password"
              />
              <p
                className="text-muted-foreground text-xs"
                id="openrouter-key-help"
              >
                Поле всегда пустое: сохранённый ключ не возвращается в браузер.
              </p>
            </div>

            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button disabled={busy || connection.isPending} type="submit">
                {openRouterActive ? "Заменить ключ" : "Подключить OpenRouter"}
              </Button>
              {openRouterActive ? (
                <Button
                  disabled={busy}
                  onClick={() => disconnect.mutate()}
                  type="button"
                  variant="outline"
                >
                  Отключить
                </Button>
              ) : null}
            </div>
          </form>
        </div>
      </PageRows>
    </PageSection>
  );
}
