import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  type ChatGptDeviceFlowMutationError,
  cancelChatGptDeviceFlowMutationOptions,
  clearPersonalAiClientState,
  disconnectPersonalAiMutationOptions,
  startChatGptDeviceFlowMutationOptions,
} from "@/lib/ai-connections/mutations";
import {
  aiConnectionKeys,
  type ChatGptDeviceFlow,
  chatGptDeviceFlowQueryOptions,
  personalAiConnectionQueryOptions,
} from "@/lib/ai-connections/queries";
import { authKeys, currentUserQueryOptions } from "@/lib/auth/queries";

const DEFAULT_POLL_INTERVAL_MS = 2_000;

function mutationFailure(error: ChatGptDeviceFlowMutationError | null) {
  switch (error?.reason) {
    case "not-authorized":
      return "Сессия завершена. Войдите снова, чтобы подключить ChatGPT.";
    case "invalid-response":
    case "unavailable":
      return "Не удалось начать подключение ChatGPT. Ничего не сохранено — попробуйте позже.";
    default:
      return null;
  }
}

function secondsUntil(expiresAt: string | undefined, clock: number) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - clock) / 1_000));
}

function expiryText(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0
    ? `Код действует ещё ${minutes} мин ${remainder} сек.`
    : `Код действует ещё ${remainder} сек.`;
}

export function ChatGptConnectionCard({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  pollIntervalMs?: number;
}) {
  const queryClient = useQueryClient();
  const currentUser = useQuery(currentUserQueryOptions());
  const actorId = currentUser.data?.id ?? "";
  const actorIdRef = useRef(actorId);
  actorIdRef.current = actorId;
  const previousActorId = useRef(actorId);
  const connection = useQuery(personalAiConnectionQueryOptions(actorId));
  const start = useMutation(
    startChatGptDeviceFlowMutationOptions(
      queryClient,
      actorId,
      () =>
        actorIdRef.current === actorId &&
        queryClient.getQueryData<{ id: string }>(authKeys.currentUser())?.id ===
          actorId,
    ),
  );
  const cancel = useMutation(
    cancelChatGptDeviceFlowMutationOptions(
      queryClient,
      actorId,
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
  const [storedAuthorization, setStoredAuthorization] = useState<{
    actorId: string;
    flow: ChatGptDeviceFlow;
  } | null>(null);
  const authorization =
    storedAuthorization?.actorId === actorId ? storedAuthorization.flow : null;
  const [clock, setClock] = useState(() => Date.now());
  const [confirmingReplacement, setConfirmingReplacement] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const connectButton = useRef<HTMLButtonElement>(null);

  const seconds = secondsUntil(authorization?.expiresAt, clock);
  const locallyExpired = Boolean(authorization) && seconds === 0;
  const signedIn = Boolean(actorId);
  const flowId = authorization?.flowId ?? "";
  const flowQueryKey = aiConnectionKeys.deviceFlow(actorId, flowId);
  const cachedFlow = queryClient.getQueryData<ChatGptDeviceFlow>(flowQueryKey);
  const cachedFlowState = queryClient.getQueryState(flowQueryKey);
  const pollingEnabled =
    signedIn &&
    Boolean(flowId) &&
    !cancel.isPending &&
    !locallyExpired &&
    cachedFlowState?.status !== "error" &&
    (cachedFlow?.state ?? authorization?.state) === "pending";
  const flow = useQuery({
    ...chatGptDeviceFlowQueryOptions(actorId, flowId),
    enabled: pollingEnabled,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return query.state.status === "error" ||
        state === "completed" ||
        state === "failed" ||
        state === "cancelled" ||
        state === "expired" ||
        Date.parse(authorization?.expiresAt ?? "") <= Date.now()
        ? false
        : pollIntervalMs;
    },
  });
  const flowState = locallyExpired
    ? "expired"
    : (flow.data?.state ?? authorization?.state);
  const active = connection.data?.state === "active";
  const chatGptActive = active && connection.data?.provider === "chatgpt";
  const busy = start.isPending || cancel.isPending || disconnect.isPending;

  useEffect(() => {
    const previous = previousActorId.current;
    previousActorId.current = actorId;
    if (!previous || previous === actorId) return;
    setStoredAuthorization(null);
    setConfirmingReplacement(false);
    start.reset();
    cancel.reset();
    disconnect.reset();
    void clearPersonalAiClientState(queryClient, previous);
  }, [actorId, cancel, disconnect, queryClient, start]);

  useEffect(() => {
    if (!authorization || flowState !== "pending") return;
    setClock(Date.now());
    const remaining = Math.max(
      0,
      Date.parse(authorization.expiresAt) - Date.now(),
    );
    const expiryTimer = window.setTimeout(
      () => setClock(Date.now()),
      remaining + 1,
    );
    const progressTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => {
      window.clearTimeout(expiryTimer);
      window.clearInterval(progressTimer);
    };
  }, [authorization, flowState]);

  useEffect(() => {
    if (!flowId || (signedIn && !locallyExpired)) return;
    void queryClient.cancelQueries({
      queryKey: aiConnectionKeys.deviceFlow(actorId, flowId),
    });
  }, [actorId, flowId, locallyExpired, queryClient, signedIn]);

  useEffect(() => {
    if (flowState !== "completed" || !authorization) return;
    let mounted = true;
    void queryClient
      .invalidateQueries({ queryKey: aiConnectionKeys.status(actorId) })
      .then(() => {
        if (mounted) setStoredAuthorization(null);
      });
    return () => {
      mounted = false;
    };
  }, [actorId, authorization, flowState, queryClient]);

  useEffect(() => {
    if (confirmingReplacement) confirmButton.current?.focus();
  }, [confirmingReplacement]);

  const begin = () => {
    setConfirmingReplacement(false);
    setStoredAuthorization(null);
    setClock(Date.now());
    cancel.reset();
    start.mutate(undefined, {
      onSuccess: (started) => {
        if (actorIdRef.current === actorId) {
          setStoredAuthorization({ actorId, flow: started });
        }
      },
    });
  };

  let status = "ChatGPT / Codex не подключён";
  if (!signedIn) status = "Сессия завершена";
  else if (connection.isPending) status = "Проверяем подключение…";
  else if (connection.isError) status = "Не удалось проверить подключение";
  else if (start.isPending) status = "Готовим код для входа…";
  else if (cancel.isPending) status = "Отменяем подключение…";
  else if (disconnect.isPending) status = "Отключаем ChatGPT…";
  else if (flow.isError) status = "Не удалось проверить подтверждение входа";
  else if (flowState === "pending") status = "Ожидаем подтверждение в ChatGPT…";
  else if (flowState === "completed") status = "Вход подтверждён";
  else if (flowState === "failed") status = "Вход не завершён";
  else if (flowState === "cancelled") status = "Подключение отменено";
  else if (flowState === "expired") status = "Срок действия кода истёк";
  else if (chatGptActive) status = "ChatGPT / Codex подключён";
  else if (active) status = "Сейчас подключён OpenRouter";

  const error =
    mutationFailure(start.error) ??
    mutationFailure(cancel.error) ??
    (disconnect.isError
      ? "Не удалось отключить ChatGPT. Попробуйте ещё раз."
      : flow.isError
        ? "Проверка входа временно недоступна. Запустите подключение ещё раз."
        : null);
  const terminal =
    flowState === "completed" ||
    flowState === "failed" ||
    flowState === "cancelled" ||
    flowState === "expired" ||
    flow.isError;

  return (
    <PageSection
      description="Вход выполняется на официальной странице OpenAI по одноразовому коду. Пароль, токены и auth-файл в этом приложении вводить не нужно."
      title="ChatGPT / Codex"
    >
      <PageRows>
        <div className="p-4">
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-sm">Личный аккаунт ChatGPT</h3>
            <p
              aria-live="polite"
              className="text-muted-foreground text-sm"
              role="status"
            >
              {status}
            </p>
          </div>

          {signedIn && flowState === "pending" && authorization ? (
            <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-sm">
                1. Откройте официальную страницу OpenAI:
              </p>
              <a
                className="break-all font-medium text-primary text-sm underline underline-offset-4"
                href={authorization.verificationUrl}
                rel="noreferrer"
                target="_blank"
              >
                {authorization.verificationUrl}
              </a>
              <p className="text-sm">2. Введите одноразовый код:</p>
              <code className="w-fit rounded-md bg-background px-3 py-2 font-semibold text-base tracking-widest">
                {authorization.userCode}
              </code>
              <p className="text-muted-foreground text-xs">
                {expiryText(seconds)} Проверка продолжится автоматически.
              </p>
            </div>
          ) : null}

          {confirmingReplacement ? (
            <section
              aria-labelledby="chatgpt-replacement-title"
              className="mt-4 flex flex-col gap-3 rounded-lg border border-border p-3"
            >
              <p className="font-medium text-sm" id="chatgpt-replacement-title">
                Заменить текущее подключение?
              </p>
              <p className="text-muted-foreground text-sm">
                После успешного входа ChatGPT заменит{" "}
                {connection.data?.provider === "openrouter"
                  ? "OpenRouter"
                  : "текущее подключение ChatGPT"}
                . Сохранённые учётные данные не показываются.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button onClick={begin} ref={confirmButton} type="button">
                  Подтвердить замену
                </Button>
                <Button
                  onClick={() => {
                    setConfirmingReplacement(false);
                    requestAnimationFrame(() => connectButton.current?.focus());
                  }}
                  type="button"
                  variant="outline"
                >
                  Отмена
                </Button>
              </div>
            </section>
          ) : null}

          {error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {flowState === "pending" && authorization ? (
              <Button
                disabled={busy}
                onClick={() => cancel.mutate(authorization.flowId)}
                type="button"
                variant="outline"
              >
                Отменить вход
              </Button>
            ) : (
              <Button
                disabled={busy || connection.isPending || !signedIn}
                onClick={() => {
                  if (active) setConfirmingReplacement(true);
                  else begin();
                }}
                ref={connectButton}
                type="button"
              >
                {terminal
                  ? "Повторить подключение"
                  : chatGptActive
                    ? "Подключить заново"
                    : active
                      ? "Заменить на ChatGPT"
                      : "Подключить ChatGPT"}
              </Button>
            )}
            {chatGptActive ? (
              <Button
                disabled={busy}
                onClick={() => disconnect.mutate()}
                type="button"
                variant="outline"
              >
                Отключить ChatGPT
              </Button>
            ) : null}
          </div>
        </div>
      </PageRows>
    </PageSection>
  );
}
