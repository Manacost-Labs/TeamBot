import { expect, test } from "bun:test";
import { join } from "node:path";

async function invokeResearchSource(
  arguments_: string[],
  responsePayload: unknown = { ok: true, data: { results: [] } },
) {
  let receivedBody: unknown;
  let receivedToken = "";
  let stdout = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      receivedToken = request.headers.get("x-source-gateway-token") ?? "";
      receivedBody = await request.json();
      return Response.json(responsePayload);
    },
  });

  try {
    const process_ = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "src", "research-source.mjs"),
        ...arguments_,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          RESEARCH_SOURCES_URL: `http://127.0.0.1:${server.port}`,
          RESEARCH_SOURCE_GATEWAY_TOKEN: "gateway-test-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await process_.exited;
    stdout = await new Response(process_.stdout).text();
    const stderr = await new Response(process_.stderr).text();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  } finally {
    server.stop(true);
  }

  return { receivedBody, receivedToken, stdout };
}

test("research-source maps bounded YouTube search onto the authenticated gateway", async () => {
  const result = await invokeResearchSource([
    "youtube-search",
    "--query",
    "Hearthstone guide",
    "--limit",
    "5",
  ]);

  expect(result.receivedToken).toBe("gateway-test-token");
  expect(result.receivedBody).toEqual({
    command: "youtube-search",
    options: { query: "Hearthstone guide", limit: 5 },
  });
});

test("research-source maps YouTube transcript without exposing a translation-cost switch", async () => {
  const result = await invokeResearchSource([
    "youtube-transcript",
    "--video",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "--language",
    "en",
  ]);

  expect(result.receivedBody).toEqual({
    command: "youtube-transcript",
    options: {
      video: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      language: "en",
    },
  });
});

test("research-source keeps bounded evidence windows but omits duplicate raw segments", async () => {
  const result = await invokeResearchSource(
    ["youtube-transcript", "--video", "dQw4w9WgXcQ"],
    {
      ok: true,
      data: {
        results: [
          {
            segment_count: 2,
            segments: [
              { start: 0, text: "Opening" },
              { start: 8, text: "Advice" },
            ],
            evidence_windows: [{ start: 0, end: 12, text: "Opening Advice" }],
          },
        ],
      },
    },
  );

  const payload = JSON.parse(result.stdout);
  expect(payload.data.results[0].segments).toBeUndefined();
  expect(payload.data.results[0].segments_omitted_from_agent_output).toBe(true);
  expect(payload.data.results[0].evidence_windows).toHaveLength(1);
  expect(payload.data.results[0].segment_count).toBe(2);
});

test("research-source maps a named MetaStats dataset onto the gateway", async () => {
  const result = await invokeResearchSource([
    "stats-api",
    "--operation",
    "dataset",
    "--source-id",
    "metastats_decks",
  ]);

  expect(result.receivedBody).toEqual({
    command: "stats-api",
    options: {
      operation: "dataset",
      source_id: "metastats_decks",
      limit: 50,
      offset: 0,
    },
  });
});
