import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { RoutineWorkerHealthStatus } from "./routine-worker-health";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("RoutineWorkerHealthStatus", () => {
  test("shows an operational worker and its last heartbeat", () => {
    const view = render(
      <RoutineWorkerHealthStatus
        worker={{
          status: "operational",
          lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
        }}
      />,
    );

    expect(view.getByRole("status").textContent).toContain(
      "Обработчик расписаний работает",
    );
    expect(view.getByRole("status").textContent).toContain("Последний сигнал");
  });

  test("makes stale and unavailable states explicit", () => {
    const view = render(
      <RoutineWorkerHealthStatus
        worker={{
          status: "stale",
          lastHeartbeatAt: "2026-08-31T11:00:00.000Z",
        }}
      />,
    );
    expect(view.getByRole("alert").textContent).toContain("давно не отвечал");

    view.rerender(
      <RoutineWorkerHealthStatus
        worker={{ status: "unavailable", lastHeartbeatAt: null }}
      />,
    );
    expect(view.getByRole("alert").textContent).toContain("недоступен");
    expect(view.getByRole("alert").textContent).toContain("Сигналов нет");
  });
});
