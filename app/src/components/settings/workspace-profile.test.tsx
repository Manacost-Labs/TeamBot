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
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { WorkspaceProfile } from "./workspace-profile";

const originalFetch = globalThis.fetch;

beforeAll(() =>
  GlobalRegistrator.register({
    url: "https://work.kolodahearthstone.com/settings",
    settings: { handleDisabledFileLoadingAsSuccess: true },
  }),
);

afterEach(() => {
  cleanup();
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

function renderProfile() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    component: WorkspaceProfile,
    getParentRoute: () => rootRoute,
    path: "/settings",
  });
  const teamRoute = createRoute({
    component: () => null,
    getParentRoute: () => rootRoute,
    path: "/admin/people",
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/settings"] }),
    routeTree: rootRoute.addChildren([settingsRoute, teamRoute]),
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("workspace profile", () => {
  test("shows the current account and the admin team link", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response({
          user: {
            id: "admin-user",
            email: "owner@example.test",
            name: "Owner",
            role: "admin",
          },
        }),
      ),
    ) as unknown as typeof fetch;

    const view = renderProfile();

    expect(await view.findByText("Owner")).toBeTruthy();
    expect(view.getByText("owner@example.test")).toBeTruthy();
    expect(view.getByText("Администратор")).toBeTruthy();
    expect(view.getByText("Команда")).toBeTruthy();
    expect(
      view.getByRole("link", { name: "Открыть управление командой" }),
    ).toBeTruthy();
  });

  test("does not offer team management to a regular member", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        response({
          user: {
            id: "member-user",
            email: "member@example.test",
            name: null,
            role: "user",
          },
        }),
      ),
    ) as unknown as typeof fetch;

    const view = renderProfile();

    expect(await view.findByText("Без имени")).toBeTruthy();
    expect(view.getByText("Участник команды")).toBeTruthy();
    expect(view.queryByText("Команда")).toBeNull();
  });

  test("keeps the failure state actionable and retries the request", async () => {
    let attempts = 0;
    globalThis.fetch = mock(() => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? response({ error: "temporary" }, 503)
          : response({
              user: {
                id: "member-user",
                email: "member@example.test",
                name: "Member",
                role: "user",
              },
            }),
      );
    }) as unknown as typeof fetch;

    const view = renderProfile();
    expect(
      await view.findByText(
        "Не удалось загрузить данные учётной записи. Повторите проверку.",
      ),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(view.getByText("Member")).toBeTruthy());
    expect(attempts).toBe(2);
  });
});
