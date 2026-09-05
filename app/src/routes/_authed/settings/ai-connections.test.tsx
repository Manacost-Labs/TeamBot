import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  MutationObserver,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { ChatGptConnectionCard } from "@/components/settings/chatgpt-connection-card";
import {
  aiConnectionKeys,
  type PersonalAiConnection,
} from "@/lib/ai-connections/queries";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { authKeys } from "@/lib/auth/queries";
import { OpenRouterSettingsCard } from "./index";

const originalFetch = globalThis.fetch;
const queryClients = new Set<QueryClient>();
const secret = "sk-or-test-plaintext-never-retain";
const flowId = "33333333-3333-4333-8333-333333333333";
const verificationUrl = "https://auth.openai.com/codex/device";
// Codex 0.150 emits five characters in the final group of its device code.
const userCode = "ABCD-EFGHJ";
const settingsActorId = "settings-user";

beforeAll(() =>
  GlobalRegistrator.register({
    url: "https://work.kolodahearthstone.com/settings",
    settings: { handleDisabledFileLoadingAsSuccess: true },
  }),
);

afterEach(() => {
  cleanup();
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
  globalThis.fetch = originalFetch;
  onlineManager.setOnline(true);
  mock.restore();
});

afterAll(() => GlobalRegistrator.unregister());

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function activeConnection(): PersonalAiConnection {
  return {
    provider: "openrouter",
    state: "active",
    validatedAt: "2026-09-01T10:00:00.000Z",
    disconnectedAt: null,
    updatedAt: "2026-09-01T10:00:01.000Z",
    safeMetadata: { limitRemainingUsd: 12.5 },
  };
}

function activeChatGptConnection(): PersonalAiConnection {
  return {
    ...activeConnection(),
    provider: "chatgpt",
    safeMetadata: {},
  };
}

function deviceFlow(
  state: "pending" | "completed" | "failed" | "cancelled" | "expired",
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
) {
  return {
    flowId,
    state,
    expiresAt,
    retryable: state !== "pending" && state !== "completed",
  };
}

function startedFlow(expiresAt?: string) {
  return {
    ...deviceFlow("pending", expiresAt),
    verificationUrl,
    userCode,
  };
}

function renderCard(initial: PersonalAiConnection | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClients.add(queryClient);
  queryClient.setQueryData(authKeys.currentUser(), {
    id: settingsActorId,
    email: "settings@example.test",
    role: "user",
  });
  queryClient.setQueryData(aiConnectionKeys.status(settingsActorId), initial);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OpenRouterSettingsCard />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function renderChatGptCard(
  initial: PersonalAiConnection | null = null,
  pollIntervalMs = 10,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClients.add(queryClient);
  queryClient.setQueryData(aiConnectionKeys.status(settingsActorId), initial);
  queryClient.setQueryData(authKeys.currentUser(), {
    id: settingsActorId,
    email: "settings@example.test",
    role: "user",
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatGptConnectionCard pollIntervalMs={pollIntervalMs} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function requestPath(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function cacheState(queryClient: QueryClient, actorId = settingsActorId) {
  return JSON.stringify({
    query: queryClient.getQueryData(aiConnectionKeys.status(actorId)),
    mutations: queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  });
}

describe("OpenRouter personal settings", () => {
  test("stores only projected status and clears plaintext after a successful connect", async () => {
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      expect(init?.body).toContain(secret);
      return Promise.resolve(
        response({
          connection: {
            ...activeConnection(),
            apiKey: secret,
            credentialId: secret,
            safeMetadata: {
              limitRemainingUsd: 12.5,
              keySuffix: secret,
            },
          },
        }),
      );
    }) as unknown as typeof fetch;

    const view = renderCard();
    const input = view.getByLabelText("Ключ OpenRouter") as HTMLInputElement;
    fireEvent.input(input, { target: { value: secret } });
    fireEvent.submit(input.form as HTMLFormElement);

    await view.findByText("OpenRouter подключён");
    expect(input.value).toBe("");
    expect(view.container.textContent).not.toContain(secret);
    expect(cacheState(view.queryClient)).not.toContain(secret);
    expect(
      view.queryClient.getQueryData<PersonalAiConnection | null>(
        aiConnectionKeys.status(settingsActorId),
      ),
    ).toEqual(activeConnection());
  });

  test("shows a safe invalid-key state and clears plaintext after failure", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(response({ error: `rejected ${secret}` }, 422)),
    ) as unknown as typeof fetch;

    const view = renderCard();
    const input = view.getByLabelText("Ключ OpenRouter") as HTMLInputElement;
    fireEvent.input(input, { target: { value: secret } });
    fireEvent.submit(input.form as HTMLFormElement);

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("Ключ OpenRouter не прошёл проверку");
    expect(alert.textContent).not.toContain(secret);
    expect(input.value).toBe("");
    expect(view.container.textContent).not.toContain(secret);
    expect(cacheState(view.queryClient)).not.toContain(secret);
  });

  test("explains connected, replacing and disconnected states in Russian", async () => {
    let finish: ((value: Response) => void) | undefined;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ) as unknown as typeof fetch;

    const view = renderCard(activeConnection());
    expect(view.getByText("OpenRouter подключён")).toBeTruthy();
    expect(view.getByRole("button", { name: "Заменить ключ" })).toBeTruthy();

    const input = view.getByLabelText("Ключ OpenRouter") as HTMLInputElement;
    fireEvent.input(input, { target: { value: secret } });
    fireEvent.submit(input.form as HTMLFormElement);

    await view.findByText("Заменяем ключ OpenRouter…");
    expect(input.value).toBe("");
    await act(async () => {
      finish?.(response({ connection: activeConnection() }));
    });
    // Retry primitive values: printing a live React DOM node on each unsuccessful
    // attempt can itself exhaust Bun's test timeout before the UI update runs.
    await waitFor(() =>
      expect(view.getByRole("status").textContent).toBe("OpenRouter подключён"),
    );

    globalThis.fetch = mock(() =>
      Promise.resolve(response({ connection: null })),
    ) as unknown as typeof fetch;
    fireEvent.click(view.getByRole("button", { name: "Отключить" }));
    await view.findByText("OpenRouter не подключён");
    expect(
      view.getByRole("button", { name: "Подключить OpenRouter" }),
    ).toBeTruthy();
  });

  test("clears a detached key input on unmount", () => {
    const view = renderCard();
    const input = view.getByLabelText("Ключ OpenRouter") as HTMLInputElement;
    fireEvent.input(input, { target: { value: secret } });

    view.unmount();

    expect(input.isConnected).toBe(false);
    expect(input.value).toBe("");
  });

  test("offers only a write-only key field without provider configuration fields", () => {
    const view = renderCard();
    const inputs = view.container.querySelectorAll("input");

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.type).toBe("password");
    expect(inputs[0]?.value).toBe("");
    expect(view.container.textContent).not.toMatch(
      /Base URL|модель|credential ID/i,
    );
  });

  test("requires confirmation before replacing ChatGPT with OpenRouter", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: requestPath(input), init });
      return Promise.resolve(response({ connection: activeConnection() }));
    }) as unknown as typeof fetch;

    const view = renderCard(activeChatGptConnection());
    const input = view.getByLabelText("Ключ OpenRouter") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const replace = view.getByRole("button", {
      name: "Заменить ChatGPT на OpenRouter",
    });
    fireEvent.click(replace);
    expect(calls).toHaveLength(0);
    expect(view.getByRole("region")).toBeTruthy();

    const confirm = view.getByRole("button", { name: "Подтвердить замену" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(view.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(document.activeElement === replace).toBe(true));

    fireEvent.click(replace);
    fireEvent.click(view.getByRole("button", { name: "Подтвердить замену" }));
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(document.activeElement).toBe(input);
    fireEvent.input(input, { target: { value: secret } });
    fireEvent.submit(input.form as HTMLFormElement);
    await view.findByText("OpenRouter подключён");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.body).toContain(secret);
    expect(view.container.textContent).not.toContain(secret);
  });
});

describe("ChatGPT personal settings", () => {
  test("shows only the official URL, one-time code and clear progress", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      calls.push({ path, init });
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      return Promise.resolve(response({ flow: deviceFlow("pending") }));
    }) as unknown as typeof fetch;

    const view = renderChatGptCard();
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));

    expect(await view.findByText(userCode)).toBeTruthy();
    const link = view.getByRole("link", { name: verificationUrl });
    expect(link.getAttribute("href")).toBe(verificationUrl);
    expect(view.getByText(/Код действует ещё/)).toBeTruthy();
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
    expect(view.container.textContent).toContain(
      "Пароль, токены и auth-файл в этом приложении вводить не нужно",
    );
    const start = calls.find((call) => call.init?.method === "POST");
    expect(start?.path).toBe("/api/ai-connections/chatgpt/device-flow");
    expect(start?.init?.body).toBe("{}");
  });

  test("requires explicit confirmation before replacing another provider", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${requestPath(input)}`);
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      return Promise.resolve(response({ flow: deviceFlow("pending") }));
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(activeConnection());
    const replace = view.getByRole("button", { name: "Заменить на ChatGPT" });
    fireEvent.click(replace);
    expect(calls).toHaveLength(0);
    expect(view.getByRole("region").textContent).not.toContain(secret);
    expect(view.getByText("Заменить текущее подключение?")).toBeTruthy();

    const confirm = view.getByRole("button", { name: "Подтвердить замену" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(view.getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(document.activeElement === replace).toBe(true));

    fireEvent.click(replace);
    fireEvent.click(view.getByRole("button", { name: "Подтвердить замену" }));
    expect(await view.findByText(userCode)).toBeTruthy();
    expect(calls[0]).toBe("POST /api/ai-connections/chatgpt/device-flow");
  });

  test("stops polling after completion and refreshes safe connection status", async () => {
    let statusCalls = 0;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      if (path === `/api/ai-connections/chatgpt/device-flow/${flowId}`) {
        statusCalls += 1;
        return Promise.resolve(response({ flow: deviceFlow("completed") }));
      }
      if (path === "/api/ai-connections") {
        return Promise.resolve(
          response({ connection: activeChatGptConnection() }),
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(null, 5);
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    await view.findByText("ChatGPT / Codex подключён");
    expect(statusCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(1);
    expect(
      view.queryClient.getQueryData<PersonalAiConnection>(
        aiConnectionKeys.status(settingsActorId),
      )?.provider,
    ).toBe("chatgpt");
  });

  test("stops polling on failure and offers a safe retry", async () => {
    let statusCalls = 0;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      statusCalls += 1;
      return Promise.resolve(response({ flow: deviceFlow("failed") }));
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(null, 5);
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    await view.findByText("Вход не завершён");
    expect(
      view.getByRole("button", { name: "Повторить подключение" }),
    ).toBeTruthy();
    expect(statusCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(1);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(1);
  });

  test("stops polling when the code expires", async () => {
    let statusCalls = 0;
    const expiresAt = new Date(Date.now() + 40).toISOString();
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow(expiresAt) }, 201));
      }
      statusCalls += 1;
      return Promise.resolve(
        response({ flow: deviceFlow("pending", expiresAt) }),
      );
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(null, 5);
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    await view.findByText("Срок действия кода истёк", {}, { timeout: 1_000 });
    const callsAtExpiry = statusCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(callsAtExpiry);
  });

  test("aborts an active poll when the card unmounts", async () => {
    let pollSignal: AbortSignal | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      pollSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;

    const view = renderChatGptCard();
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    await waitFor(() => expect(pollSignal).toBeDefined());
    view.unmount();
    expect(pollSignal?.aborted).toBe(true);
  });

  test("stops polling and hides the device code on sign-out", async () => {
    let statusCalls = 0;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      if (path === "/api/me") {
        return Promise.resolve(response({}, 401));
      }
      statusCalls += 1;
      return Promise.resolve(response({ flow: deviceFlow("pending") }));
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(null, 5);
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    expect(await view.findByText(userCode)).toBeTruthy();
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
    view.queryClient.removeQueries({ queryKey: authKeys.all });
    await view.findByText("Сессия завершена");
    expect(view.queryByText(userCode)).toBeNull();
    const callsAtSignOut = statusCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(callsAtSignOut);
  });

  test("purges actor-scoped AI state before another user signs in", async () => {
    let statusCalls = 0;
    let finishSignOut: ((value: Response) => void) | undefined;
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (
        path === "/api/ai-connections/chatgpt/device-flow" &&
        init?.method === "POST"
      ) {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      if (path === "/api/auth/sign-out" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          finishSignOut = resolve;
        });
      }
      if (path === "/api/me") return Promise.resolve(response({}, 401));
      if (path === "/api/ai-connections") {
        return Promise.resolve(response({ connection: null }));
      }
      statusCalls += 1;
      return Promise.resolve(response({ flow: deviceFlow("pending") }));
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(activeConnection(), 5);
    fireEvent.click(view.getByRole("button", { name: "Заменить на ChatGPT" }));
    fireEvent.click(view.getByRole("button", { name: "Подтвердить замену" }));
    expect(await view.findByText(userCode)).toBeTruthy();
    await waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    const signOut = new MutationObserver(
      view.queryClient,
      signOutMutationOptions(view.queryClient),
    );
    const signOutRequest = signOut.mutate();
    await waitFor(() => expect(finishSignOut).toBeDefined());

    // Model a request that was already in flight when the optimistic purge ran: both query and
    // mutation state for actor A return while the sign-out HTTP request is still pending.
    act(() => {
      view.queryClient.setQueryData(
        aiConnectionKeys.status(settingsActorId),
        activeConnection(),
      );
    });
    const lateMutation = new MutationObserver(view.queryClient, {
      mutationKey: [...aiConnectionKeys.actor(settingsActorId), "late-refill"],
      mutationFn: () => Promise.resolve(),
    });
    await lateMutation.mutate();
    expect(
      view.queryClient.getQueriesData({ queryKey: aiConnectionKeys.all }),
    ).not.toEqual([]);
    expect(
      view.queryClient.getMutationCache().findAll({
        mutationKey: aiConnectionKeys.all,
      }),
    ).not.toEqual([]);

    await act(async () => {
      finishSignOut?.(response({}));
      await signOutRequest;
    });
    await view.findByText("Сессия завершена");
    expect(view.queryByText(userCode)).toBeNull();
    await waitFor(() => {
      expect(
        view.queryClient.getQueriesData({ queryKey: aiConnectionKeys.all }),
      ).toEqual([]);
      expect(
        view.queryClient.getMutationCache().findAll({
          mutationKey: aiConnectionKeys.all,
        }),
      ).toEqual([]);
    });

    const secondActorId = "settings-user-b";
    act(() => {
      view.queryClient.setQueryData(authKeys.currentUser(), {
        id: secondActorId,
        email: "settings-b@example.test",
        role: "user",
      });
      view.queryClient.setQueryData(
        aiConnectionKeys.status(secondActorId),
        null,
      );
    });
    await view.findByText("ChatGPT / Codex не подключён");
    expect(view.queryByText(userCode)).toBeNull();
    expect(view.queryByText("Сейчас подключён OpenRouter")).toBeNull();
  });

  test("cancels the active flow and stops polling", async () => {
    let statusCalls = 0;
    let cancelCalls = 0;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      if (init?.method === "DELETE") {
        cancelCalls += 1;
        return Promise.resolve(response({ flow: deviceFlow("cancelled") }));
      }
      statusCalls += 1;
      return Promise.resolve(response({ flow: deviceFlow("pending") }));
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(null, 5);
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    await view.findByText(userCode);
    fireEvent.click(view.getByRole("button", { name: "Отменить вход" }));
    await view.findByText("Подключение отменено");
    expect(cancelCalls).toBe(1);
    const callsAtCancel = statusCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(callsAtCancel);
  });

  test("keeps cancelled when a delayed status request returns pending", async () => {
    let statusCalls = 0;
    let finishStatus: ((value: Response) => void) | undefined;
    let finishCancel: ((value: Response) => void) | undefined;
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(response({ flow: startedFlow() }, 201));
      }
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          finishCancel = resolve;
        });
      }
      statusCalls += 1;
      return new Promise<Response>((resolve) => {
        finishStatus = resolve;
      });
    }) as unknown as typeof fetch;

    const view = renderChatGptCard(null, 5);
    fireEvent.click(view.getByRole("button", { name: "Подключить ChatGPT" }));
    expect(await view.findByText(userCode)).toBeTruthy();
    await waitFor(() => expect(finishStatus).toBeDefined());

    fireEvent.click(view.getByRole("button", { name: "Отменить вход" }));
    await view.findByText("Отменяем подключение…");
    await waitFor(() => expect(finishCancel).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(1);

    await act(async () => {
      finishCancel?.(response({ flow: deviceFlow("cancelled") }));
    });
    await view.findByText("Подключение отменено");

    await act(async () => {
      finishStatus?.(response({ flow: deviceFlow("pending") }));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statusCalls).toBe(1);
    expect(view.getByText("Подключение отменено")).toBeTruthy();
    expect(
      view.queryClient.getQueryData<{ state: string }>(
        aiConnectionKeys.deviceFlow(settingsActorId, flowId),
      )?.state,
    ).toBe("cancelled");
  });
});
