import { describe, expect, test } from "bun:test";
import { ARTIFACT_RESULT_SCHEMA } from "../../shared/artifact-contract";
import type { ArtifactExportStore } from "../src/artifacts/export-store";
import type { ArtifactRenderer } from "../src/artifacts/renderer-client";
import {
  createArtifactTools,
  parseCreateArtifactArgs,
} from "../src/artifacts/service";
import type { AttachmentUploadService } from "../src/attachments/lifecycle";
import type {
  AttachmentRecord,
  AttachmentStore,
} from "../src/attachments/store";
import type { Database } from "../src/db/client";

const context = {
  actorId: "actor-a",
  botId: "bot-a",
  runId: "run-a",
  threadId: "thread-a",
};
const exportId = "10000000-0000-4000-8000-000000000001";
const attachmentId = "20000000-0000-4000-8000-000000000002";
const leaseToken = "30000000-0000-4000-8000-000000000003";

function record(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: attachmentId,
    ownerUserId: "actor-a",
    channelId: "channel-a",
    messageId: `artifact:${exportId}`,
    name: "report.md",
    mimeType: "text/markdown",
    size: 8,
    sha256: "a".repeat(64),
    storageKey: "40000000-0000-4000-8000-000000000004",
    source: "agent_generated",
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    ...overrides,
  };
}

function dependencies(
  options: {
    claim?: Awaited<ReturnType<ArtifactExportStore["claim"]>>;
    existing?: AttachmentRecord | null;
    listed?: AttachmentRecord[];
    uploaded?: AttachmentRecord | null;
    authorized?: boolean;
    renderer?: ArtifactRenderer;
  } = {},
) {
  const calls: Record<string, unknown[]> = {
    claim: [],
    complete: [],
    fail: [],
    invalidate: [],
    upload: [],
    render: [],
  };
  const database = {
    async execute() {
      return options.authorized === false ? [] : [{ channelId: "channel-a" }];
    },
  } as unknown as Database;
  const exports: ArtifactExportStore = {
    async claim(input) {
      calls.claim?.push(input);
      return (
        options.claim ?? {
          kind: "claimed",
          exportId,
          leaseToken,
          messageId: `artifact:${exportId}`,
        }
      );
    },
    async complete(...args) {
      calls.complete?.push(args);
      return true;
    },
    async fail(...args) {
      calls.fail?.push(args);
      return true;
    },
    async invalidateReady(...args) {
      calls.invalidate?.push(args);
      return true;
    },
  };
  const attachments: Pick<AttachmentStore, "get" | "list"> = {
    async get() {
      return options.existing ?? null;
    },
    async list() {
      return { attachments: options.listed ?? [], nextCursor: null };
    },
  };
  const uploaded = options.uploaded === undefined ? record() : options.uploaded;
  const uploads: AttachmentUploadService = {
    async reserve() {
      return {
        storageKey: "40000000-0000-4000-8000-000000000004",
        leaseToken: "50000000-0000-4000-8000-000000000005",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
    },
    async cancel() {
      return true;
    },
    async upload(...args) {
      calls.upload?.push(args);
      return uploaded;
    },
  };
  return {
    calls,
    tools: createArtifactTools({
      database,
      exports,
      attachments,
      uploads,
      ...(options.renderer ? { renderer: options.renderer } : {}),
    }),
  };
}

describe("create artifact argument contract", () => {
  test("accepts every bounded governed MIME/extension pair", () => {
    expect(
      parseCreateArtifactArgs({
        title: " Отчёт ",
        filename: "report.md",
        mimeType: "text/markdown",
        content: "# Report",
        workspacePath: null,
      }),
    ).toEqual({
      title: "Отчёт",
      filename: "report.md",
      mimeType: "text/markdown",
      content: "# Report",
    });
    for (const [filename, mimeType, content] of [
      ["notes.txt", "text/plain", "Notes"],
      ["data.json", "application/json", '{"safe":true}'],
      ["table.csv", "text/csv", "name,value\nSafe,1"],
      [
        "diagram.svg",
        "image/svg+xml",
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ],
      ["page.html", "text/html", "<!doctype html><p>Report</p>"],
      ["report.pdf", "application/pdf", "# Report"],
    ] as const) {
      expect(
        parseCreateArtifactArgs({
          title: "Report",
          filename,
          mimeType,
          content,
        })?.mimeType,
      ).toBe(mimeType);
    }
  });

  test("rejects malformed or excessively nested JSON", () => {
    const input = {
      title: "Data",
      filename: "data.json",
      mimeType: "application/json",
    };
    expect(
      parseCreateArtifactArgs({ ...input, content: '{"open":' }),
    ).toBeNull();

    let nested = "0";
    for (let depth = 0; depth < 101; depth += 1) {
      nested = `{"child":${nested}}`;
    }
    expect(parseCreateArtifactArgs({ ...input, content: nested })).toBeNull();
  });

  test("rejects path tricks, reserved names, extension spoofing and two sources", () => {
    const valid = {
      title: "Report",
      filename: "report.md",
      mimeType: "text/markdown",
      content: "Body",
    };
    for (const input of [
      { ...valid, filename: "../report.md" },
      { ...valid, filename: "CON.md" },
      { ...valid, filename: "report.pdf" },
      { ...valid, workspacePath: "out/report.md" },
      { ...valid, extra: "field" },
    ]) {
      expect(parseCreateArtifactArgs(input)).toBeNull();
    }
  });

  test("enforces the UTF-8 byte limit rather than JavaScript code units", () => {
    expect(
      parseCreateArtifactArgs({
        title: "Report",
        filename: "report.md",
        mimeType: "text/markdown",
        content: "я".repeat(1024 * 1024),
      }),
    ).toBeNull();
  });
});

describe("governed artifact creation", () => {
  test("stores Markdown as an idempotent agent-generated attachment", async () => {
    const { calls, tools } = dependencies();
    const result = await tools.createArtifact(context, {
      title: "Report",
      filename: "report.md",
      mimeType: "text/markdown",
      content: "# Report",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        schema: ARTIFACT_RESULT_SCHEMA,
        artifact: {
          attachmentId,
          filename: "report.md",
          mimeType: "text/markdown",
          size: 8,
          title: "Report",
        },
      },
    });
    expect(calls.claim).toHaveLength(1);
    expect(calls.upload?.[0]?.[2]).toBe("agent_generated");
    expect(calls.upload?.[0]?.[4]).toMatchObject({
      messageId: `artifact:${exportId}`,
      name: "report.md",
      mimeType: "text/markdown",
    });
    expect(calls.complete).toEqual([[exportId, leaseToken, attachmentId]]);
  });

  test.each([
    ["notes.txt", "text/plain", "Notes"],
    ["data.json", "application/json", '{"safe":true}'],
    ["table.csv", "text/csv", "name,value\nSafe,1"],
    [
      "diagram.svg",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    ],
    ["page.html", "text/html", "<!doctype html><p>Report</p>"],
  ] as const)(
    "stores %s without invoking the PDF renderer",
    async (filename, mimeType, content) => {
      const generated = record({
        name: filename,
        mimeType,
        size: Buffer.byteLength(content),
      });
      const { calls, tools } = dependencies({ uploaded: generated });

      const result = await tools.createArtifact(context, {
        title: "Report",
        filename,
        mimeType,
        content,
      });

      expect(result).toMatchObject({
        ok: true,
        value: { artifact: { filename, mimeType } },
      });
      expect(calls.upload?.[0]?.[4]).toMatchObject({
        name: filename,
        mimeType,
      });
    },
  );

  test("renders PDF only through the configured isolated renderer", async () => {
    const pdfRecord = record({
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 12,
    });
    let rendererInput: unknown;
    const renderer: ArtifactRenderer = {
      async renderMarkdown(input) {
        rendererInput = input;
        return new TextEncoder().encode("%PDF-1.7\nOK");
      },
    };
    const { tools } = dependencies({ renderer, uploaded: pdfRecord });

    const result = await tools.createArtifact(context, {
      title: "Отчёт",
      filename: "report.pdf",
      mimeType: "application/pdf",
      content: "# Итог",
    });

    expect(result.ok).toBe(true);
    expect(rendererInput).toMatchObject({ title: "Отчёт", markdown: "# Итог" });
  });

  test("returns a ready attachment without rendering or uploading again", async () => {
    const existing = record();
    const { calls, tools } = dependencies({
      claim: { kind: "ready", exportId, attachmentId },
      existing,
    });

    expect(
      (
        await tools.createArtifact(context, {
          title: "Report",
          filename: "report.md",
          mimeType: "text/markdown",
          content: "# Report",
        })
      ).ok,
    ).toBe(true);
    expect(calls.upload).toEqual([]);
  });

  test("invalidates a ready row when its attachment metadata does not match", async () => {
    let claimCount = 0;
    const mismatch = record({ name: "different.md" });
    const harness = dependencies({ existing: mismatch });
    harness.tools = createArtifactTools({
      database: {
        async execute() {
          return [{ channelId: "channel-a" }];
        },
      } as unknown as Database,
      exports: {
        async claim() {
          claimCount += 1;
          return claimCount === 1
            ? { kind: "ready", exportId, attachmentId }
            : {
                kind: "claimed",
                exportId,
                leaseToken,
                messageId: `artifact:${exportId}`,
              };
        },
        async complete(...args) {
          harness.calls.complete?.push(args);
          return true;
        },
        async fail(...args) {
          harness.calls.fail?.push(args);
          return true;
        },
        async invalidateReady(...args) {
          harness.calls.invalidate?.push(args);
          return true;
        },
      },
      attachments: {
        async get() {
          return mismatch;
        },
        async list() {
          return { attachments: [], nextCursor: null };
        },
      },
      uploads: {
        async reserve() {
          return {
            storageKey: "40000000-0000-4000-8000-000000000004",
            leaseToken: "50000000-0000-4000-8000-000000000005",
            leaseExpiresAt: new Date(Date.now() + 60_000),
          };
        },
        async cancel() {
          return true;
        },
        async upload() {
          return record();
        },
      },
    });

    expect(
      (
        await harness.tools.createArtifact(context, {
          title: "Report",
          filename: "report.md",
          mimeType: "text/markdown",
          content: "# Report",
        })
      ).ok,
    ).toBe(true);
    expect(harness.calls.invalidate).toEqual([[exportId, attachmentId]]);
    expect(claimCount).toBe(2);
  });

  test("recovers a published attachment left by an expired process", async () => {
    const orphan = record();
    const { calls, tools } = dependencies({ listed: [orphan] });

    expect(
      (
        await tools.createArtifact(context, {
          title: "Report",
          filename: "report.md",
          mimeType: "text/markdown",
          content: "# Report",
        })
      ).ok,
    ).toBe(true);
    expect(calls.upload).toEqual([]);
    expect(calls.complete).toEqual([[exportId, leaseToken, attachmentId]]);
  });

  test("fails closed for unauthorized, busy and unavailable source paths", async () => {
    const unauthorized = dependencies({ authorized: false }).tools;
    expect(
      await unauthorized.createArtifact(context, {
        title: "Report",
        filename: "report.md",
        mimeType: "text/markdown",
        content: "Body",
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const busy = dependencies({ claim: { kind: "busy" } }).tools;
    expect(
      await busy.createArtifact(context, {
        title: "Report",
        filename: "report.md",
        mimeType: "text/markdown",
        content: "Body",
      }),
    ).toMatchObject({ ok: false, error: { code: "BUSY" } });

    const noPdfRenderer = dependencies().tools;
    expect(
      await noPdfRenderer.createArtifact(context, {
        title: "Report",
        filename: "report.pdf",
        mimeType: "application/pdf",
        content: "Body",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE" },
    });

    expect(
      await dependencies().tools.createArtifact(context, {
        title: "Report",
        filename: "report.md",
        mimeType: "text/markdown",
        workspacePath: "reports/report.md",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_UNAVAILABLE" },
    });
  });
});
