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
import { cleanup, render } from "@testing-library/react";
import {
  authProvidersQueryOptions,
  type SignInOptions,
} from "@/lib/auth/queries";
import { SignScreen } from "./sign";

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

describe("Telegram sign-in", () => {
  test("renders a same-origin OIDC start form without loading Telegram scripts", () => {
    const fetchTelegram = mock(() =>
      Promise.reject(new Error("the OIDC button must not fetch in JavaScript")),
    );
    globalThis.fetch = fetchTelegram as unknown as typeof fetch;
    const telegram = renderSignScreen({
      providers: [],
      sso: false,
      telegram: { botUsername: "ManacostTeamBot" },
    });

    expect(telegram.getByRole("heading", { level: 1 }).textContent).toBe(
      "Вход в ManacostTeam",
    );
    const button = telegram.getByRole("button", {
      name: "Продолжить через Telegram",
    });
    const form = button.closest("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe(
      "/api/auth/telegram/start?returnPath=/",
    );
    expect(telegram.container.querySelector("script")).toBeNull();
    expect(telegram.container.querySelector("iframe")).toBeNull();
    expect(telegram.queryByText(/Продолжить через Google/)).toBeNull();
    expect(fetchTelegram).not.toHaveBeenCalled();
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
      oauth.container.querySelector("form[action*='telegram']"),
    ).toBeNull();
    expect(fetchOAuth).not.toHaveBeenCalled();
  });

  test("shows only a generic Russian message after a callback refusal", () => {
    window.history.replaceState(null, "", "/sign?telegramError=1");

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
    expect(view.getByRole("button", { name: /Telegram/ })).toBeTruthy();
  });
});
