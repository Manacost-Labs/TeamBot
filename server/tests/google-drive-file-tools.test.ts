import { afterEach, describe, expect, test } from "bun:test";
import type { GoogleDriveFileBridge } from "../src/plugins/google-drive-file-bridge";
import {
  callTool,
  listTools,
  useGoogleDriveFileBridge,
} from "../src/plugins/google-drive-rest";

const attachmentId = "10000000-0000-4000-8000-000000000001";
const connection = {
  url: "https://attacker.invalid/ignored",
  token: "person-token",
  actorId: "actor-a",
  botId: "bot-a",
  threadId: "thread-a",
  runId: "run-a",
};
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  useGoogleDriveFileBridge(null);
});

function bridge(
  overrides: Partial<GoogleDriveFileBridge> = {},
): GoogleDriveFileBridge {
  return {
    async withOperationLock(_id, operation) {
      return operation();
    },
    async recoverImport() {
      return { ok: true, value: null };
    },
    async publishImport(_context, input) {
      expect(await new Response(input.body).text()).toBe("# imported");
      return {
        ok: true,
        value: {
          attachmentId,
          name: input.name,
          mimeType: input.mimeType,
          size: 10,
          source: "google_export",
        },
      };
    },
    async attachmentForUpload() {
      return {
        ok: true,
        value: {
          attachment: {
            id: attachmentId,
            messageId: "message-a",
            name: "notes.txt",
            mimeType: "text/plain",
            size: 4,
            source: "user_upload",
            createdAt: "2026-08-31T00:00:00Z",
          },
          async openStream() {
            return new Blob(["data"]).stream();
          },
        },
      };
    },
    ...overrides,
  };
}

function sequence(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit; body?: string }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const body = init?.body ? await new Response(init.body).text() : undefined;
    calls.push({ url: String(input), init, body });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return calls;
}

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Google Drive file bridge tools", () => {
  test("advertises four bounded bridge schemas", async () => {
    const tools = await listTools(connection);
    for (const name of [
      "import_google_drive_file_to_chat",
      "upload_attachment_to_google_drive",
      "create_google_drive_folder",
      "move_google_drive_file",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.additionalProperties).toBe(false);
    }
  });

  test("refuses a write bridge without a trusted run id", async () => {
    useGoogleDriveFileBridge(bridge());
    const result = await callTool(
      { ...connection, runId: undefined },
      "create_google_drive_folder",
      { name: "Reports" },
    );
    expect(result.isError).toBe(true);
  });

  test("exports a native Drive file into a deterministic chat attachment", async () => {
    useGoogleDriveFileBridge(bridge());
    const calls = sequence([
      json({
        id: "doc_1",
        name: "Plan",
        mimeType: "application/vnd.google-apps.document",
      }),
      new Response("# imported", {
        headers: { "content-type": "text/markdown" },
      }),
    ]);

    const result = await callTool(
      connection,
      "import_google_drive_file_to_chat",
      {
        fileId: "doc_1",
      },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).attachment).toMatchObject({
      attachmentId,
      name: "Plan.md",
      source: "google_export",
    });
    expect(calls[1].url).toStartWith("https://www.googleapis.com/drive/v3/");
    expect(calls[1].init?.redirect).toBe("manual");
  });

  test("uploads only the conversation source and resolves an ambiguous POST without retry", async () => {
    useGoogleDriveFileBridge(bridge());
    const created = {
      id: "drive_1",
      name: "notes.txt",
      mimeType: "text/plain",
      webViewLink: "https://drive.google.com/file/d/drive_1/view",
      parents: [],
    };
    const calls = sequence([
      json({ files: [] }),
      new Error("connection lost after send"),
      json({ files: [created] }),
    ]);

    const result = await callTool(
      connection,
      "upload_attachment_to_google_drive",
      {
        attachmentId,
      },
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).file.id).toBe("drive_1");
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
      1,
    );
    expect(calls[1].url).toStartWith(
      "https://www.googleapis.com/upload/drive/v3/files",
    );
    expect(calls[1].body).toContain("openbotOperation");
    expect(calls[1].body).toContain("data");
  });

  test("creates an idempotent folder with a verified exact parent", async () => {
    useGoogleDriveFileBridge(bridge());
    const folder = {
      id: "folder_1",
      name: "Reports",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root_1"],
    };
    const calls = sequence([
      json({ files: [] }),
      json({
        id: "root_1",
        name: "Root",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      }),
      json(folder),
      json(folder),
    ]);

    const result = await callTool(connection, "create_google_drive_folder", {
      name: "Reports",
      parentId: "root_1",
    });
    expect(result.isError).toBe(false);
    expect(calls[2].init?.method).toBe("POST");
    expect(calls[2].body).toContain('"parents":["root_1"]');
  });

  test("moves only after exact parent verification and explicit confirmation", async () => {
    useGoogleDriveFileBridge(bridge());
    const calls = sequence([
      json({
        id: "target_1",
        name: "Target",
        mimeType: "application/vnd.google-apps.folder",
        trashed: false,
      }),
      json({
        id: "file_1",
        name: "Plan",
        mimeType: "text/plain",
        parents: ["old_1"],
      }),
      json({
        id: "file_1",
        name: "Plan",
        mimeType: "text/plain",
        parents: ["target_1"],
      }),
      json({
        id: "file_1",
        name: "Plan",
        mimeType: "text/plain",
        parents: ["target_1"],
      }),
    ]);
    const result = await callTool(connection, "move_google_drive_file", {
      fileId: "file_1",
      folderId: "target_1",
      expectedParentIds: ["old_1"],
      confirm: true,
    });
    expect(result.isError).toBe(false);
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(new URL(patch?.url ?? "").searchParams.get("removeParents")).toBe(
      "old_1",
    );

    const refused = await callTool(connection, "move_google_drive_file", {
      fileId: "file_1",
      folderId: "target_1",
      expectedParentIds: ["old_1"],
      confirm: false,
    });
    expect(refused.isError).toBe(true);
  });
});
