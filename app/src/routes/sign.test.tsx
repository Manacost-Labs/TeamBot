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
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  authProvidersQueryOptions,
  type SignInOptions,
} from "@/lib/auth/queries";
import { SignScreen, TelegramLoginWidget } from "./sign";

const originalFetch = globalThis.fetch;
const queryClients = new Set<QueryClient>();

beforeAll(() =>
  GlobalRegistrator.register({
    url: "https://work.kolodahearthstone.com/sign",
    settings: { handleDisabledFileLoadingAsSuccess: true },
  }),
);
afterEach(() => {
  cleanup();
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
  window.history.replaceState(null, "", "/sign");
  globalThis.fetch = originalFetch;
  mock.restore();
});
afterAll(() => GlobalRegistrator.unregister());

function renderSignScreen(options: SignInOptions) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClients.add(queryClient);
  queryClient.setQueryData(authProvidersQueryOptions().queryKey, options);

  return render(
    <QueryClientProvider client={queryClient}>
      <SignScreen />
    </QueryClientProvider>,
  );
}

function stateResponse(state = "a".repeat(64)) {
  return new Response(JSON.stringify({ state }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Telegram sign-in", () => {
  test("renders Telegram mode without changing the OAuth screen", async () => {
    const fetchTelegram = mock(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(stateResponse()),
    );
    globalThis.fetch = fetchTelegram as unknown as typeof fetch;

    const telegram = renderSignScreen({
      providers: [],
      sso: false,
      telegram: { botUsername: "ManacostTeamBot" },
    });

    await waitFor(() =>
      expect(
        telegram.container.querySelector(
          'script[src="https://telegram.org/js/telegram-widget.js?22"]',
        ),
      ).not.toBeNull(),
    );
    expect(telegram.queryByText(/Продолжить через Google/)).toBeNull();
    expect(fetchTelegram).toHaveBeenCalledTimes(1);
    expect(fetchTelegram.mock.calls[0]?.[0]).toBe(
      "/api/auth/telegram/state?returnPath=/",
    );
    expect(fetchTelegram.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    telegram.unmount();

    const fetchOAuth = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.reject(new Error("state must not be requested in OAuth mode")),
    );
    globalThis.fetch = fetchOAuth as unknown as typeof fetch;
    const oauth = renderSignScreen({
      providers: ["google"],
      sso: false,
      telegram: null,
    });

    expect(oauth.getByText("Продолжить через Google")).toBeTruthy();
    expect(
      oauth.container.querySelector(
        'script[src="https://telegram.org/js/telegram-widget.js?22"]',
      ),
    ).toBeNull();
    expect(fetchOAuth).not.toHaveBeenCalled();
  });

  test("shows a generic Russian failure when the one-time state cannot be loaded", async () => {
    globalThis.fetch = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "sensitive internal reason" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const view = renderSignScreen({
      providers: [],
      sso: false,
      telegram: { botUsername: "ManacostTeamBot" },
    });

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain(
      "Не удалось подготовить вход через Telegram",
    );
    expect(alert.textContent).not.toContain("sensitive internal reason");
    expect(view.container.querySelector("script")).toBeNull();
  });

  test("cancels an unfinished state request when the screen closes", async () => {
    const request: {
      signal: AbortSignal | null;
      finish: ((response: Response) => void) | null;
    } = { signal: null, finish: null };
    globalThis.fetch = mock(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          request.signal = init?.signal ?? null;
          request.finish = resolve;
        }),
    ) as unknown as typeof fetch;

    const view = renderSignScreen({
      providers: [],
      sso: false,
      telegram: { botUsername: "ManacostTeamBot" },
    });
    await waitFor(() => expect(request.signal).not.toBeNull());

    view.unmount();
    expect(request.signal?.aborted).toBe(true);
    request.finish?.(stateResponse());
  });

  test("shows only a generic Russian message after a callback refusal", async () => {
    window.history.replaceState(null, "", "/sign?telegramError=1");
    globalThis.fetch = mock((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(stateResponse()),
    ) as unknown as typeof fetch;

    const view = renderSignScreen({
      providers: [],
      sso: false,
      telegram: { botUsername: "ManacostTeamBot" },
    });

    const alert = view.getByRole("alert");
    expect(alert.textContent).toBe(
      "Не удалось выполнить вход через Telegram. Попробуйте ещё раз.",
    );
    expect(view.container.textContent).not.toContain("callback");
    expect(view.container.textContent).not.toContain("state");
    await waitFor(() =>
      expect(
        view.container.querySelector(
          'script[src="https://telegram.org/js/telegram-widget.js?22"]',
        ),
      ).not.toBeNull(),
    );
  });

  test("loads only the official widget with a fixed same-origin callback and cleans it up", () => {
    const state = "b".repeat(64);
    const onError = mock(() => {});
    const view = render(
      <TelegramLoginWidget
        botUsername="ManacostTeamBot"
        onError={onError}
        state={state}
      />,
    );
    const script = view.container.querySelector("script");

    expect(script).not.toBeNull();
    expect(script?.src).toBe("https://telegram.org/js/telegram-widget.js?22");
    expect(script?.getAttribute("data-telegram-login")).toBe("ManacostTeamBot");
    expect(script?.getAttribute("data-auth-url")).toBe(
      `https://work.kolodahearthstone.com/api/auth/telegram/callback?state=${state}`,
    );
    expect(script?.getAttribute("data-auth-url")).not.toContain(
      "internal-auth",
    );
    expect(script?.getAttribute("data-auth-url")).not.toContain("returnPath");
    expect(onError).not.toHaveBeenCalled();

    view.unmount();
    expect(script?.isConnected).toBe(false);
  });

  test("rejects script, username and state injection before creating the widget", () => {
    const onError = mock(() => {});
    const view = render(
      <TelegramLoginWidget
        botUsername={'BadBot" data-auth-url="https://evil.example'}
        onError={onError}
        state={`${"c".repeat(63)}&`}
      />,
    );

    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).not.toContain("evil.example");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
