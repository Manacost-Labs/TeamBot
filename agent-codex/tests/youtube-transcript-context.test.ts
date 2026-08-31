import { describe, expect, it } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  youtubeTranscriptContext,
  youtubeVideoUrls,
} from "../src/youtube-transcript-context";

describe("trusted YouTube transcript preloading", () => {
  it("uses unique links from only the latest user message", () => {
    const input = youtubeInput([
      { id: "u1", role: "user", content: "https://youtu.be/oldoldold00" },
      { id: "a1", role: "assistant", content: "done" },
      {
        id: "u2",
        role: "user",
        content:
          "https://youtu.be/9TLANtoG9c8 and 9TLANtoG9c8 plus https://www.youtube.com/shorts/dQw4w9WgXcQ",
      },
    ]);

    expect(youtubeVideoUrls(input)).toEqual([
      "https://www.youtube.com/watch?v=9TLANtoG9c8",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ]);
  });

  it("preloads bounded evidence without exposing raw segments or the gateway token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const context = await youtubeTranscriptContext(
      youtubeInput([
        {
          id: "u",
          role: "user",
          content: "https://www.youtube.com/watch?v=9TLANtoG9c8",
        },
      ]),
      {
        sourceUrl: "http://source.test",
        token: "secret-gateway-token",
        timeoutMs: 5_000,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(url), init });
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                collected_at: "2026-08-31T18:45:00Z",
                warnings: [],
                results: [
                  {
                    source_id: "9TLANtoG9c8",
                    source_url: "https://www.youtube.com/watch?v=9TLANtoG9c8",
                    caption_provider: "transcriptapi",
                    segment_count: 208,
                    content_hash: "abc123",
                    segments: [{ text: "duplicated raw caption" }],
                    evidence_windows: [
                      {
                        start: 0,
                        end: 30,
                        segment_count: 8,
                        text: "Useful context",
                        timestamp_url:
                          "https://www.youtube.com/watch?v=9TLANtoG9c8&t=0s",
                      },
                    ],
                  },
                ],
              },
            }),
          );
        }) as typeof fetch,
      },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://source.test/v1/source");
    expect(requests[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      "x-source-gateway-token": "secret-gateway-token",
    });
    expect(context).toContain('trust="untrusted"');
    expect(context).toContain("Useful context");
    expect(context).toContain('"segmentCount":208');
    expect(context).not.toContain("duplicated raw caption");
    expect(context).not.toContain("secret-gateway-token");
  });

  it("returns a bounded status block when the provider fails", async () => {
    const context = await youtubeTranscriptContext(
      youtubeInput([
        {
          id: "u",
          role: "user",
          content: "https://youtu.be/9TLANtoG9c8",
        },
      ]),
      {
        token: "token",
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: "RATE_LIMITED",
                message: "unsafe provider detail",
                retryable: true,
              },
            }),
            { status: 429 },
          )) as typeof fetch,
      },
    );

    expect(context).toContain('"reason":"RATE_LIMITED"');
    expect(context).toContain('"retryable":true');
    expect(context).not.toContain("unsafe provider detail");
  });

  it("does not silently drop requests beyond the five-video limit", async () => {
    const ids = [
      "aaaaaaaaaaa",
      "bbbbbbbbbbb",
      "ccccccccccc",
      "ddddddddddd",
      "eeeeeeeeeee",
      "fffffffffff",
    ];
    const context = await youtubeTranscriptContext(
      youtubeInput([
        {
          id: "u",
          role: "user",
          content: ids.map((id) => `https://youtu.be/${id}`).join(" "),
        },
      ]),
      {
        token: "token",
        fetchImpl: (async () => {
          throw new Error("must not fetch");
        }) as typeof fetch,
      },
    );

    expect(context).toContain('"status":"too_many_video_links"');
    expect(context).toContain('"supplied":6');
  });
});

function youtubeInput(
  messages: Array<{ id: string; role: string; content: string }>,
): RunAgentInput {
  return {
    agentId: process.env.YOUTUBE_ANALYST_AGENT_ID?.trim() || "youtube-analyst",
    runId: "run",
    threadId: "thread",
    messages,
    tools: [],
    context: [],
    state: {},
  } as unknown as RunAgentInput;
}
