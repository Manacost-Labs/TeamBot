import { describe, expect, test } from "bun:test";
import { bindGrantedToolsToRun } from "../src/copilot";
import { grantedTools } from "../src/plugins/tools";

describe("built-in tool run context", () => {
  test("binds concurrent runs independently and ignores identity-shaped model arguments", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = {
      async listForAgent() {
        return {
          tools: [
            {
              ref: "conversation-attachments/list_conversation_attachments",
              toolName:
                "mcp__conversation-attachments__list_conversation_attachments",
              description: "List this conversation's attachments.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          skills: [],
        };
      },
      async callTool(input: Record<string, unknown>) {
        await Promise.resolve();
        calls.push(input);
        return {
          text: `${String(input.runId)}:${String(input.threadId)}`,
          isError: false,
        };
      },
    };
    const [unbound] = await grantedTools({
      store: store as never,
      botId: "trusted-bot",
      actorId: "trusted-actor",
    });
    if (!unbound) throw new Error("Expected one granted tool");

    const [first] = bindGrantedToolsToRun([unbound], {
      runId: "run-a",
      threadId: "thread-a",
    });
    const [second] = bindGrantedToolsToRun([unbound], {
      runId: "run-b",
      threadId: "thread-b",
    });
    const forged = {
      actorId: "forged-actor",
      botId: "forged-bot",
      runId: "forged-run",
      threadId: "forged-thread",
    };

    const [a, b] = await Promise.all([
      first?.execute(forged),
      second?.execute(forged),
    ]);

    expect([a, b].sort()).toEqual(["run-a:thread-a", "run-b:thread-b"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "trusted-actor",
          botId: "trusted-bot",
          runId: "run-a",
          threadId: "thread-a",
          args: forged,
        }),
        expect.objectContaining({
          actorId: "trusted-actor",
          botId: "trusted-bot",
          runId: "run-b",
          threadId: "thread-b",
          args: forged,
        }),
      ]),
    );
  });
});
