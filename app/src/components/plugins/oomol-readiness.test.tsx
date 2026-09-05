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
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { PluginServer } from "@/lib/plugins/queries";

let PluginRoute: typeof import("@/routes/_authed/admin/plugins/$key").Route;
let OomolReadiness: typeof import("./oomol-readiness").OomolReadiness;

const originalFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register({
    url: "http://localhost/",
    settings: { handleDisabledFileLoadingAsSuccess: true },
  });
  // Portal support detects the DOM at module initialization.
  ({ OomolReadiness } = await import("./oomol-readiness"));
  ({ Route: PluginRoute } = await import(
    "@/routes/_authed/admin/plugins/$key"
  ));
});
afterEach(async () => {
  await act(async () => cleanup());
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const server: PluginServer = {
  id: "oomol-connector",
  title: "OOMOL Connector",
  vendor: "OOMOL",
  url: "https://connector.oomol.com/v1",
  summary: "",
  docsUrl: "",
  provenance: "first-party",
  hasCredential: true,
  toolsRefreshedAt: "2026-09-05T10:00:00Z",
  lastError: null,
  addedBy: null,
  dynamicClient: false,
  withdrawn: [],
  tools: [
    "googledocs.get_document",
    "googlesheets.get_spreadsheet",
    "github.get_current_user",
  ].map((name) => ({
    serverId: "oomol-connector",
    name,
    ref: `oomol-connector/${name}`,
    description: "",
    inputSchema: {},
    effect: "write",
    grantedTo: [],
  })),
};
const actions = () => ({
  onConfigure: mock(() => {}),
  onRefresh: mock(() => {}),
  onGrant: mock(() => {}),
  agents: [{ id: "bot-1", hasCallbackToken: false }],
  botsMayCallBack: true,
});

describe("OOMOL setup guidance", () => {
  test("explains shared ownership and opens setup only after an explicit click", () => {
    const callbacks = actions();
    const view = render(<OomolReadiness {...callbacks} />);
    expect(view.getByText(/Общее подключение команды/)).toBeTruthy();
    expect(view.getByText(/Google Cloud/)).toBeTruthy();
    expect(callbacks.onConfigure).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Подключить OOMOL" }));
    expect(callbacks.onConfigure).toHaveBeenCalledTimes(1);
    expect(callbacks.onRefresh).not.toHaveBeenCalled();
    expect(callbacks.onGrant).not.toHaveBeenCalled();
  });
  test("shows discovered service groups and sends grants through the existing explicit dialog", () => {
    const callbacks = actions();
    const view = render(<OomolReadiness {...callbacks} server={server} />);
    for (const name of ["Google Docs", "Google Sheets", "GitHub"])
      expect(view.getByText(name)).toBeTruthy();
    expect(view.getByText(/не проверяет выполнение/)).toBeTruthy();
    fireEvent.click(
      view.getByRole("button", { name: "Выбрать агентов и действия" }),
    );
    expect(callbacks.onGrant).toHaveBeenCalledTimes(1);
  });
  test("keeps cached tools visible on a failed refresh and recovers after a successful retry", () => {
    const callbacks = actions();
    const view = render(
      <OomolReadiness
        {...callbacks}
        server={{ ...server, lastError: "key rejected (401)" }}
      />,
    );
    expect(view.getByRole("alert").textContent).toContain("ключ");
    expect(view.getByText("Google Docs")).toBeTruthy();
    expect(view.getByText(/Предыдущий список/)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Повторить проверку" }));
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(1);
    view.rerender(<OomolReadiness {...callbacks} server={server} refreshing />);
    expect(
      view.getByRole("button", { name: "Проверяем…" }).hasAttribute("disabled"),
    ).toBe(true);
    view.rerender(<OomolReadiness {...callbacks} server={server} />);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("Выберите агентов");
  });
  test("distinguishes empty discovery from no key and never displays a fake connected state", () => {
    const callbacks = actions();
    const view = render(
      <OomolReadiness {...callbacks} server={{ ...server, tools: [] }} />,
    );
    expect(view.getByRole("status").textContent).toContain(
      "Действия не найдены",
    );
    expect(view.queryByText("Google Docs")).toBeNull();
    view.rerender(
      <OomolReadiness
        {...callbacks}
        server={{ ...server, hasCredential: false }}
      />,
    );
    expect(view.getByRole("button", { name: "Добавить ключ" })).toBeTruthy();
  });
  test("does not offer a grant dialog when no agents are available", () => {
    const view = render(
      <OomolReadiness {...actions()} server={server} agents={[]} />,
    );
    expect(
      view.queryByRole("button", { name: "Выбрать агентов и действия" }),
    ).toBeNull();
    expect(view.getByText(/В доступном списке пока нет агентов/)).toBeTruthy();
    expect(view.getByText(/Верните скрытого агента/)).toBeTruthy();
  });
  test("does not confuse an unavailable roster with an empty roster", () => {
    const view = render(
      <OomolReadiness {...actions()} server={server} agents={undefined} />,
    );
    expect(view.getByRole("status").textContent).toContain(
      "Список агентов пока недоступен",
    );
    expect(view.queryByText(/В доступном списке пока нет агентов/)).toBeNull();
    expect(
      view.queryByRole("button", { name: "Выбрать агентов и действия" }),
    ).toBeNull();
  });
  test("shows missing callback configuration and unresolved grants without granting access", () => {
    const callbacks = actions();
    const view = render(
      <OomolReadiness
        {...callbacks}
        server={{
          ...server,
          tools: [{ ...server.tools[0]!, grantedTo: ["bot-1", "unresolved"] }],
        }}
        agents={[{ id: "bot-1", hasCallbackToken: false }]}
        botsMayCallBack={false}
      />,
    );
    expect(view.getByRole("status").textContent).toContain(
      "Настройте вызов инструментов",
    );
    expect(view.getByText(/Вне доступного списка: 1/)).toBeTruthy();
    expect(callbacks.onGrant).not.toHaveBeenCalled();
  });
});

test("real plugin screen reflects a failed HTTP-200 discovery and recovers on retry without changing grants", async () => {
  let current = server;
  let refreshes = 0;
  const unexpectedWrites: string[] = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const json = (body: unknown) => Response.json(body);
      if (
        path === "/api/plugins/servers/oomol-connector/refresh" &&
        request.method === "POST"
      ) {
        refreshes += 1;
        current = {
          ...server,
          lastError: refreshes === 1 ? "OOMOL rejected key (401)." : null,
        };
        return json({ tools: refreshes === 1 ? 0 : 3, server: current });
      }
      if (request.method !== "GET") unexpectedWrites.push(path);
      if (path === "/api/plugins")
        return json({
          servers: [current],
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          catalogue: [
            {
              key: "oomol-connector",
              title: "OOMOL Connector",
              auth: "deployment-bearer",
              summary: "",
              docsUrl: "",
            },
          ],
        });
      if (path === "/api/plugins/connections")
        return json({ connections: [], redirectUri: null });
      if (path === "/api/agents")
        return json({
          agents: [{ id: "bot-1", name: "Analyst", hasCallbackToken: false }],
        });
      throw new Error(`Unexpected test request: ${request.method} ${path}`);
    },
  ) as unknown as typeof fetch;
  const { client, view } = mountPluginScreen();
  try {
    fireEvent.click(
      await view.findByRole("button", { name: "Проверить список действий" }),
    );
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("ключ"),
    );
    expect(view.getByText("Google Docs")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Повторить проверку" }));
    await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
    expect(
      view.getByRole("button", { name: "Выбрать агентов и действия" }),
    ).toBeTruthy();
    expect(refreshes).toBe(2);
    expect(unexpectedWrites).toEqual([]);
  } finally {
    await act(async () => {
      view.unmount();
      client.clear();
    });
  }
});

function mountPluginScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    getParentRoute: () => root,
    id: "_authed",
    component: Outlet,
  });
  const route = createRoute({
    getParentRoute: () => authed,
    path: "admin/plugins/$key",
    component: PluginRoute.options.component,
  });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ["/admin/plugins/oomol-connector"],
    }),
    routeTree: root.addChildren([authed.addChildren([route])]),
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router, view };
}

test("a save completing after navigation does not reset a newer refresh", async () => {
  // Base UI caches DOM availability at import time. Other suite files import it
  // before Happy DOM exists, so exercise the real portal in a fresh unit-test process.
  // This is still mocked HTTP + Happy DOM, not browser/visual acceptance.
  if (process.env.OPENBOT_TEST_OOMOL_NAV_CHILD !== "1") {
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        import.meta.path,
        "--test-name-pattern",
        "^a save completing after navigation does not reset a newer refresh$",
      ],
      {
        env: { ...process.env, OPENBOT_TEST_OOMOL_NAV_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(stderr).toContain("1 pass");
    return;
  }
  const saving = Promise.withResolvers<Response>();
  const refreshing = Promise.withResolvers<Response>();
  let saveStarted = false;
  let refreshStarted = false;
  let reads = 0;
  const other = { ...server, id: "other", title: "Other connector" };
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/plugins/servers" && request.method === "POST") {
        saveStarted = true;
        return saving.promise;
      }
      if (
        path === "/api/plugins/servers/oomol-connector/refresh" &&
        request.method === "POST"
      ) {
        refreshStarted = true;
        return refreshing.promise;
      }
      if (request.method !== "GET")
        throw new Error(`Unexpected fixture write: ${path}`);
      if (path === "/api/plugins") {
        reads++;
        return Response.json({
          servers: [server, other],
          skills: [],
          botsMayCallBack: true,
          redirectUri: null,
          catalogue: [server, other].map((item) => ({
            key: item.id,
            title: item.title,
            auth: "deployment-bearer",
            summary: "",
            docsUrl: "",
          })),
        });
      }
      if (path === "/api/plugins/connections")
        return Response.json({ connections: [], redirectUri: null });
      if (path === "/api/agents")
        return Response.json({
          agents: [{ id: "bot-1", name: "Analyst", hasCallbackToken: true }],
        });
      throw new Error(`Unexpected fixture request: ${path}`);
    },
  ) as unknown as typeof fetch;
  const { client, router, view } = mountPluginScreen();
  try {
    fireEvent.click(await view.findByRole("button", { name: "Заменить ключ" }));
    fireEvent.click(await view.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveStarted).toBe(true));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await router.navigate({
        to: "/admin/plugins/$key",
        params: { key: "other" },
      });
    });
    expect(
      await view.findByRole("button", { name: "Refresh tools" }),
    ).toBeTruthy();
    await act(async () => {
      await router.navigate({
        to: "/admin/plugins/$key",
        params: { key: "oomol-connector" },
      });
    });
    fireEvent.click(
      await view.findByRole("button", { name: "Проверить список действий" }),
    );
    await waitFor(() => expect(refreshStarted).toBe(true));
    expect(
      view.getByRole("button", { name: "Проверяем…" }).hasAttribute("disabled"),
    ).toBe(true);
    const readsBeforeSave = reads;
    await act(async () => {
      saving.resolve(Response.json({ server }));
    });
    await waitFor(() => expect(reads).toBeGreaterThan(readsBeforeSave));
    await waitFor(() => expect(client.isMutating()).toBe(1));
    expect(
      view.getByRole("button", { name: "Проверяем…" }).hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    await act(async () => {
      saving.resolve(Response.json({ server }));
      refreshing.resolve(Response.json({ tools: 3, server }));
      await Promise.all([saving.promise, refreshing.promise]);
      view.unmount();
      client.clear();
    });
  }
});
