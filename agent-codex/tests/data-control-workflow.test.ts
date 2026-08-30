import { describe, expect, test } from "bun:test";
import { DataControlWorkflow } from "../src/data-control-workflow";

describe("Контроль данных workflow enforcement", () => {
  test("keeps a deterministic local defect unresolved after diagnosis alone", () => {
    const workflow = new DataControlWorkflow();
    workflow.recordToolResult(
      "mcp__parser-ops__diagnose_source",
      { sourceId: "hsreplay_arena" },
      JSON.stringify({
        source: { id: "hsreplay_arena" },
        triage: { disposition: "inspect_adapter" },
      }),
    );

    expect(workflow.unresolvedSourceIds()).toEqual(["hsreplay_arena"]);
    expect(workflow.correctionMessage()).toContain("not complete yet");
  });

  test("recognizes a diagnosis by its governed result shape", () => {
    const workflow = new DataControlWorkflow();
    workflow.recordToolResult(
      "deployment-tool-call",
      {},
      JSON.stringify({
        source: { id: "hsreplay_arena" },
        triage: { disposition: "inspect_adapter" },
      }),
    );

    expect(workflow.unresolvedSourceIds()).toEqual(["hsreplay_arena"]);
  });

  test("clears a defect only after publish verification is fresh", () => {
    const workflow = new DataControlWorkflow();
    workflow.recordToolResult(
      "mcp__parser-ops__diagnose_source",
      { sourceId: "hsreplay_arena" },
      JSON.stringify({
        source: { id: "hsreplay_arena" },
        triage: { disposition: "inspect_adapter" },
      }),
    );
    workflow.recordToolResult(
      "mcp__parser-ops__publish_and_verify",
      { sourceIds: ["hsreplay_arena"] },
      JSON.stringify({
        published: true,
        verification: {
          results: [{ sourceId: "hsreplay_arena", outcome: "fresh_published" }],
        },
      }),
    );

    expect(workflow.unresolvedSourceIds()).toEqual([]);
    expect(workflow.correctionMessage()).toBeUndefined();
  });

  test("does not block proven upstream-only conditions", () => {
    const workflow = new DataControlWorkflow();
    workflow.recordToolResult(
      "mcp__parser-ops__diagnose_source",
      { sourceId: "publisher" },
      JSON.stringify({
        source: { id: "publisher" },
        triage: { disposition: "upstream_pending" },
      }),
    );

    expect(workflow.unresolvedSourceIds()).toEqual([]);
  });
});
