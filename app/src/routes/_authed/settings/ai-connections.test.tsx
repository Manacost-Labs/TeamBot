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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import {
  aiConnectionKeys,
  type PersonalAiConnection,
} from "@/lib/ai-connections/queries";
import { OpenRouterSettingsCard } from "./index";

const originalFetch = globalThis.fetch;
const queryClients = new Set<QueryClient>();
const secret = "sk-or-test-plaintext-never-retain";

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

function renderCard(initial: PersonalAiConnection | null = null) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClients.add(queryClient);
  queryClient.setQueryData(aiConnectionKeys.status(), initial);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <OpenRouterSettingsCard />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function cacheState(queryClient: QueryClient) {
  return JSON.stringify({
    query: queryClient.getQueryData(aiConnectionKeys.status()),
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
        aiConnectionKeys.status(),
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
    await waitFor(() =>
      expect(view.queryByText("Заменяем ключ OpenRouter…")).toBeNull(),
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
});
