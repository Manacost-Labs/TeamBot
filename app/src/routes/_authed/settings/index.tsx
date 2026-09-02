import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { RoutineWorkerHealthIndicator } from "@/components/routines/routine-worker-health";
import { ChatGptConnectionCard } from "@/components/settings/chatgpt-connection-card";
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
  clearPersonalAiClientState,
  connectOpenRouterMutationOptions,
  disconnectPersonalAiMutationOptions,
} from "@/lib/ai-connections/mutations";
import { personalAiConnectionQueryOptions } from "@/lib/ai-connections/queries";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";

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
      description={`Внешний вид, доступ к ИИ и интеграции ${appConfig.brand.productName} для вашей учётной записи.`}
      title="Настройки рабочего пространства"
    >
      <PageSection title="Внешний вид">
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
      <PageSection
        description="Показываем реальный сигнал обработчика расписаний, а не только его настройки."
        title="Состояние автоматизации"
      >
        <RoutineWorkerHealthIndicator />
      </PageSection>
      <OpenRouterSettingsCard />
      <ChatGptConnectionCard />
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
  const replacementButton = useRef<HTMLButtonElement>(null);
  const replacementConfirmButton = useRef<HTMLButtonElement>(null);
  const [confirmingReplacement, setConfirmingReplacement] = useState(false);
  const [replacementApproved, setReplacementApproved] = useState(false);
  const currentUser = useQuery(currentUserQueryOptions());
  const actorId = currentUser.data?.id ?? "";
  const actorIdRef = useRef(actorId);
  actorIdRef.current = actorId;
  const previousActorId = useRef(actorId);
  const connection = useQuery(personalAiConnectionQueryOptions(actorId));
  const takeApiKey = () => {
    const input = keyInput.current;
    if (!input) return "";
    const value = input.value.trim();
    input.value = "";
    return value;
  };
  const connect = useMutation(
    connectOpenRouterMutationOptions(
      queryClient,
      actorId,
      takeApiKey,
      () =>
        actorIdRef.current === actorId &&
        queryClient.getQueryData<{ id: string }>(authKeys.currentUser())?.id ===
          actorId,
    ),
  );
  const disconnect = useMutation(
    disconnectPersonalAiMutationOptions(
      queryClient,
      actorId,
      () =>
        actorIdRef.current === actorId &&
        queryClient.getQueryData<{ id: string }>(authKeys.currentUser())?.id ===
          actorId,
    ),
  );
  const active = connection.data?.state === "active";
  const openRouterActive = active && connection.data?.provider === "openrouter";
  const replacing = connect.isPending && active;
  const replacingChatGpt =
    active && connection.data?.provider === "chatgpt" && !replacementApproved;

  useEffect(() => {
    const input = keyInput.current;
    return () => {
      if (input) input.value = "";
    };
  }, []);

  useEffect(() => {
    const previous = previousActorId.current;
    previousActorId.current = actorId;
    if (previous === actorId) return;
    if (keyInput.current) keyInput.current.value = "";
    setConfirmingReplacement(false);
    setReplacementApproved(false);
    connect.reset();
    disconnect.reset();
    if (previous) void clearPersonalAiClientState(queryClient, previous);
  }, [actorId, connect, disconnect, queryClient]);

  useEffect(() => {
    if (confirmingReplacement) replacementConfirmButton.current?.focus();
  }, [confirmingReplacement]);

  useEffect(() => {
    if (replacementApproved) keyInput.current?.focus();
  }, [replacementApproved]);

  useEffect(() => {
    if (!active || connection.data?.provider !== "chatgpt") {
      setConfirmingReplacement(false);
      setReplacementApproved(false);
    }
  }, [active, connection.data?.provider]);

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
      title="Доступ к ИИ"
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
              if (replacingChatGpt) {
                if (keyInput.current) keyInput.current.value = "";
                setConfirmingReplacement(true);
                return;
              }
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
                disabled={busy || replacingChatGpt}
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

            {confirmingReplacement ? (
              <section
                aria-labelledby="openrouter-replacement-title"
                className="flex flex-col gap-3 rounded-lg border border-border p-3"
              >
                <p
                  className="font-medium text-sm"
                  id="openrouter-replacement-title"
                >
                  Заменить ChatGPT на OpenRouter?
                </p>
                <p className="text-muted-foreground text-sm">
                  Подтвердите смену провайдера, затем вставьте новый ключ.
                  Данные текущего подключения не показываются.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    onClick={() => {
                      setConfirmingReplacement(false);
                      setReplacementApproved(true);
                    }}
                    ref={replacementConfirmButton}
                    type="button"
                  >
                    Подтвердить замену
                  </Button>
                  <Button
                    onClick={() => {
                      setConfirmingReplacement(false);
                      replacementButton.current?.focus();
                    }}
                    type="button"
                    variant="outline"
                  >
                    Отмена
                  </Button>
                </div>
              </section>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                disabled={busy || connection.isPending || !actorId}
                ref={replacementButton}
                type="submit"
              >
                {openRouterActive
                  ? "Заменить ключ"
                  : replacingChatGpt
                    ? "Заменить ChatGPT на OpenRouter"
                    : "Подключить OpenRouter"}
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
