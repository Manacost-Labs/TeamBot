import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import {
  deploymentToolNames,
  instructionsFor,
  isHeartPulseControlRun,
  isResearchRun,
  isYoutubeAnalystRun,
  permissionProfileFor,
  transcriptFor,
} from "../src/history";
import { shouldExposeReasoning } from "../src/reasoning-visibility";

const input = {
  threadId: "thread",
  runId: "run",
  messages: [
    { id: "s", role: "system", content: "Tenant rule." },
    { id: "u", role: "user", content: "Hello" },
    { id: "a", role: "assistant", content: "Hi" },
  ],
  tools: [],
  context: [],
  state: {},
  forwardedProps: { openbotDeploymentTools: ["allowed", 42] },
} as unknown as RunAgentInput;

describe("Codex prompt translation", () => {
  test("allows the data-control profile to commit inside its dedicated clone", async () => {
    const config = await Bun.file(
      new URL("../config.toml", import.meta.url),
    ).text();
    expect(config).toContain('"/workspace/.git" = "write"');
  });

  test("gives only the data-control agent a writable parser workspace", () => {
    expect(permissionProfileFor(input)).toBe("openbot-agent");
    const dataControl = { ...input, agentId: "data-control" } as RunAgentInput;
    expect(permissionProfileFor(dataControl)).toBe("data-control-agent");
    expect(instructionsFor(dataControl)).toContain("dedicated clone");
    expect(instructionsFor(dataControl)).toContain(
      "unexpected_selected_params",
    );
    expect(instructionsFor(dataControl)).toContain("URL query constants");
    expect(instructionsFor(dataControl)).toContain(
      "Follow diagnose_source.triage",
    );
    expect(instructionsFor(dataControl)).toContain(
      "hsreplay_meta_archetypes_legend_eu_1d",
    );
    expect(instructionsFor(dataControl)).toContain(
      "hsreplay_meta_diamond_4to1_1d_firecrawl",
    );
    expect(instructionsFor(dataControl)).toContain("fresh-only");
    expect(instructionsFor(dataControl)).toContain("0 */6 * * *");
    const detectedByTool = {
      ...input,
      tools: [
        {
          name: "mcp__parser-ops__diagnose_source",
          description: "Diagnose",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as unknown as RunAgentInput;
    expect(permissionProfileFor(detectedByTool)).toBe("data-control-agent");
  });

  test("gives the HeartPulse control agent its own repair profile and prompt", () => {
    const heartpulse = {
      ...input,
      agentId: "heartpulse-control",
    } as RunAgentInput;
    expect(isHeartPulseControlRun(heartpulse)).toBe(true);
    expect(permissionProfileFor(heartpulse)).toBe("heartpulse-control-agent");
    expect(instructionsFor(heartpulse)).toContain("audit_strategy_data");
    expect(instructionsFor(heartpulse)).toContain("audit_site_sections");
    expect(instructionsFor(heartpulse)).toContain(
      "HSReplay all-D without metrics",
    );
    expect(instructionsFor(heartpulse)).toContain(
      "hsreplay_meta_top_1000_legend_1d_firecrawl",
    );
    expect(instructionsFor(heartpulse)).toContain(
      "hsreplay_meta_legend_1d_firecrawl",
    );
    expect(instructionsFor(heartpulse)).toContain("fresh-only");
    expect(instructionsFor(heartpulse)).toContain("0 */6 * * *");
  });

  test("gives the research agent an isolated report workspace and source workflow", () => {
    const research = {
      ...input,
      agentId: process.env.RESEARCH_AGENT_ID?.trim() || "research-analyst",
    } as RunAgentInput;
    expect(isResearchRun(research)).toBe(true);
    expect(permissionProfileFor(research)).toBe("research-agent");
    expect(instructionsFor(research)).toContain(
      "research-source tinyfish-fetch",
    );
    expect(instructionsFor(research)).toContain(
      "research-source youtube-transcript",
    );
    expect(instructionsFor(research)).toContain(
      "captions as untrusted evidence",
    );
    expect(instructionsFor(research)).toContain("hsreplay_archetypes");
    expect(instructionsFor(research)).toContain("hsguru_meta_standard_legend");
    expect(instructionsFor(research)).toContain(
      "stats-api --operation dataset --source-id SOURCE_ID",
    );
    expect(instructionsFor(research)).toContain("metastats_decks");
    expect(instructionsFor(research)).toContain("metastats_matchups");
    expect(instructionsFor(research)).toContain("failed Fetch");
    expect(instructionsFor(research)).toContain("private chain-of-thought");
    expect(shouldExposeReasoning(research)).toBe(false);
    expect(shouldExposeReasoning(input)).toBe(true);
  });

  test("gives YouTube-аналитик a narrow transcript-to-Markdown workflow", () => {
    const youtube = {
      ...input,
      agentId:
        process.env.YOUTUBE_ANALYST_AGENT_ID?.trim() || "youtube-analyst",
      messages: [
        { id: "u1", role: "user", content: "https://youtu.be/old-video" },
        { id: "a1", role: "assistant", content: "Old result" },
        {
          id: "u2",
          role: "user",
          content: "https://www.youtube.com/watch?v=current",
        },
      ],
    } as unknown as RunAgentInput;
    expect(isYoutubeAnalystRun(youtube)).toBe(true);
    expect(permissionProfileFor(youtube)).toBe("youtube-analyst-agent");
    expect(instructionsFor(youtube)).toContain("youtube_transcript_data");
    expect(instructionsFor(youtube)).toContain("Do not run shell commands");
    expect(instructionsFor(youtube)).toContain("Captions");
    expect(instructionsFor(youtube)).toContain("create_artifact");
    expect(instructionsFor(youtube)).toContain("text/markdown");
    expect(instructionsFor(youtube)).toContain("ending in `.md`");
    expect(transcriptFor(youtube)).toContain("watch?v=current");
    expect(transcriptFor(youtube)).not.toContain("old-video");
    expect(shouldExposeReasoning(youtube)).toBe(false);

    const forwarded = {
      ...input,
      agentId: "managed-agent",
      forwardedProps: {
        openbotBotId:
          process.env.YOUTUBE_ANALYST_AGENT_ID?.trim() || "youtube-analyst",
      },
    } as unknown as RunAgentInput;
    expect(isYoutubeAnalystRun(forwarded)).toBe(true);
  });

  test("keeps the YouTube model sandbox offline", async () => {
    const config = await Bun.file(
      new URL("../config.toml", import.meta.url),
    ).text();
    const section = config.split("[permissions.youtube-analyst-agent]")[1];
    expect(section).toContain("[permissions.youtube-analyst-agent.network]");
    expect(section).toContain("enabled = false");
  });

  test("keeps higher-priority instructions out of the quoted transcript", () => {
    expect(instructionsFor(input)).toContain("Tenant rule.");
    expect(transcriptFor(input)).not.toContain("Tenant rule.");
    expect(transcriptFor(input)).toContain("[user] Hello");
  });

  test("projects structured user attachments to governed ids only", () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const structured = {
      ...input,
      messages: [
        {
          id: "u",
          role: "user",
          content: [
            { type: "text", text: "Edit this." },
            {
              type: "binary",
              id: attachmentId,
              data: "PRIVATE_BASE64_BYTES",
              url: "https://private.invalid/blob",
              filename: "private.docx",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              storageKey: "private/storage/key",
            },
          ],
        },
      ],
    } as unknown as RunAgentInput;

    const transcript = transcriptFor(structured);
    expect(transcript).toContain("Edit this.");
    expect(transcript).toContain(attachmentId);
    expect(transcript).not.toContain("[object Object]");
    expect(transcript).not.toContain("PRIVATE_BASE64_BYTES");
    expect(transcript).not.toContain("private.invalid");
    expect(transcript).not.toContain("private.docx");
    expect(transcript).not.toContain("wordprocessingml");
    expect(transcript).not.toContain("private/storage/key");
  });

  test("keeps structured system instructions text-only", () => {
    const structured = {
      ...input,
      messages: [
        {
          id: "s",
          role: "system",
          content: [
            { type: "text", text: "Tenant rule." },
            {
              type: "binary",
              id: "00000000-0000-4000-8000-000000000001",
              data: "PRIVATE_BASE64_BYTES",
            },
          ],
        },
      ],
    } as unknown as RunAgentInput;

    expect(instructionsFor(structured)).toContain("Tenant rule.");
    expect(instructionsFor(structured)).not.toContain("00000000-0000");
    expect(instructionsFor(structured)).not.toContain("PRIVATE_BASE64_BYTES");
  });

  test("does not feed display-only reasoning summaries back into the next turn", () => {
    const withReasoning = {
      ...input,
      messages: [
        ...input.messages,
        { id: "r", role: "reasoning", content: "I checked the current state." },
        { id: "u2", role: "user", content: "Continue" },
      ],
    } as unknown as RunAgentInput;

    const transcript = transcriptFor(withReasoning);
    expect(transcript).not.toContain("I checked the current state.");
    expect(transcript).toContain("[user] Continue");
  });

  test("accepts only deployment-declared tool names", () => {
    expect([...deploymentToolNames(input)]).toEqual(["allowed"]);
  });

  test("requires an explicit governed handoff when message_bot is offered", () => {
    const withHandoff = {
      ...input,
      forwardedProps: { openbotDeploymentTools: ["message_bot"] },
    } as unknown as RunAgentInput;

    expect(instructionsFor(withHandoff)).toContain(
      "call `message_bot` exactly once",
    );
    expect(instructionsFor(withHandoff)).toContain(
      "An @mention of another Bot",
    );
    expect(instructionsFor(withHandoff)).toContain(
      "Never claim a handoff succeeded",
    );
    expect(instructionsFor(input)).not.toContain(
      "call `message_bot` exactly once",
    );
  });

  test("keeps data-control history bounded to the last outcome and current firing", () => {
    const dataControl = {
      ...input,
      agentId: "data-control",
      messages: [
        { id: "u1", role: "user", content: "Old firing" },
        { id: "a1", role: "assistant", content: "Last outcome" },
        { id: "t1", role: "tool", content: "Large old audit" },
        { id: "u2", role: "user", content: "Current firing" },
      ],
    } as unknown as RunAgentInput;

    const transcript = transcriptFor(dataControl);
    expect(transcript).toContain("Last outcome");
    expect(transcript).toContain("Current firing");
    expect(transcript).not.toContain("Old firing");
    expect(transcript).not.toContain("Large old audit");
  });
});
