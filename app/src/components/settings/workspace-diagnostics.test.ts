import { describe, expect, test } from "bun:test";
import {
  buildWorkspaceDiagnostics,
  type QuerySnapshot,
  type WorkspaceDiagnosticInput,
} from "./workspace-diagnostics";

const query = <T>(data: T): QuerySnapshot<T> & { data: T } => ({
  data,
  isError: false,
  isPending: false,
});

const pending = <T>(): QuerySnapshot<T> => ({
  isError: false,
  isPending: true,
});

const failed = <T>(): QuerySnapshot<T> => ({
  isError: true,
  isPending: false,
});

function baseInput(): WorkspaceDiagnosticInput {
  return {
    ai: query({
      provider: "chatgpt" as const,
      state: "active" as const,
      validatedAt: "2026-09-01T10:00:00.000Z",
      disconnectedAt: null,
      updatedAt: "2026-09-01T10:00:00.000Z",
      safeMetadata: {},
    }),
    connections: query({ available: [], connected: [] }),
    currentUser: query({
      id: "user-1",
      email: "editor@example.test",
      name: "Редактор",
      role: "user" as const,
    }),
    worker: query({
      status: "operational" as const,
      lastHeartbeatAt: "2026-09-02T00:00:00.000Z",
    }),
  };
}

describe("workspace diagnostics", () => {
  test("keeps a healthy workspace green and explains the active provider", () => {
    const diagnostics = buildWorkspaceDiagnostics(baseInput());

    expect(diagnostics.map(({ id, state }) => [id, state])).toEqual([
      ["session", "connected"],
      ["ai", "connected"],
      ["integrations", "inactive"],
      ["automation", "connected"],
    ]);
    expect(diagnostics[1]?.description).toContain("ChatGPT / Codex подключён");
  });

  test("does not turn a missing personal AI connection into a false success", () => {
    const input = baseInput();
    input.ai = query(null);
    const diagnostics = buildWorkspaceDiagnostics(input);

    expect(diagnostics.find(({ id }) => id === "ai")).toMatchObject({
      state: "attention",
      stateLabel: "Нужно подключить",
    });
  });

  test("separates transient checks from unavailable dependencies", () => {
    const input = baseInput();
    input.ai = pending();
    input.connections = failed();
    input.worker = query({ status: "stale", lastHeartbeatAt: null });

    expect(buildWorkspaceDiagnostics(input).map(({ state }) => state)).toEqual([
      "connected",
      "checking",
      "unavailable",
      "attention",
    ]);
  });

  test("counts only enabled personal integrations", () => {
    const input = baseInput();
    input.connections = query({
      available: [{ serverId: "google-drive", title: "Google Drive" }],
      connected: [
        {
          serverId: "google-drive",
          connectedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    });

    expect(
      buildWorkspaceDiagnostics(input).find(({ id }) => id === "integrations"),
    ).toMatchObject({
      state: "connected",
      description: "Подключено: 1 из 1.",
    });
  });
});
