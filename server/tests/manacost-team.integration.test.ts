import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  manacostAutonomyRuns,
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
  skillTools,
  users,
} from "../src/db/schema";
import { createManacostTeamService } from "../src/plugins/manacost-team";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const suite = randomUUID().slice(0, 8);
const actorId = `manacost_actor_${suite}`;
const botId = `manacost_bot_${suite}`;
const serverId = `manacost_parser_${suite}`;
const skillSlug = `core/manacost-${suite}`;
const toolRef = `${serverId}/audit_all_sources`;

const service = createManacostTeamService({
  database,
  encryptionKey: "m".repeat(44),
  executeParserAction: async ({ action, input }) => ({
    action,
    input,
    terminalOutcome: "verified",
  }),
});

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: actorId, email: `${actorId}@example.test`, name: actorId })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({
      id: botId,
      name: botId,
      type: "remote_ag_ui",
      configuration: {},
    })
    .onConflictDoNothing();
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Manacost parser test server",
      vendor: "test",
      url: "builtin://parser-ops-test",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: "audit_all_sources",
      description: "Run a bounded audit.",
    })
    .onConflictDoNothing();
  await database
    .insert(skills)
    .values({
      id: skillSlug,
      slug: skillSlug,
      title: "Manacost test skill",
      summary: "A canonical test skill.",
      instructions: "Run the bounded parser audit.",
      origin: "canonical",
      sourceRoot: "/tmp/manacost-test",
      sourceRepo: "https://example.test/skills",
      sourceCommit: "a".repeat(40),
      manifestHash: "b".repeat(64),
      provenance: { kind: "canonical", rootId: "test" },
    })
    .onConflictDoNothing();
  await database
    .insert(skillTools)
    .values({ skillId: skillSlug, ref: toolRef, declaredBy: "test" })
    .onConflictDoNothing();
  await database
    .insert(pluginGrants)
    .values([
      { kind: "skill", ref: skillSlug, agentId: botId, grantedBy: actorId },
      { kind: "mcp", ref: toolRef, agentId: botId, grantedBy: actorId },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await database
    .delete(manacostAutonomyRuns)
    .where(eq(manacostAutonomyRuns.actorId, actorId));
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(skillTools).where(eq(skillTools.skillId, skillSlug));
  await database.delete(skills).where(eq(skills.slug, skillSlug));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.delete(users).where(eq(users.id, actorId));
  await database.$client.end({ timeout: 5 });
});

async function waitForCompletion(runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.getRun(runId, actorId);
    if (run?.status === "completed" || run?.status === "failed") return run;
    await Bun.sleep(10);
  }
  throw new Error("The ManacostTeam run did not finish in time.");
}

describe("ManacostTeam durable autonomy", () => {
  test("continues a granted parser action in the background and records checkpoints", async () => {
    const started = await service.startRun({
      actorId,
      botId,
      skillSlug,
      action: "audit",
      input: { sourceIds: ["alpha"] },
    });
    expect(started.run?.status).toBe("running");

    const completed = await waitForCompletion(started.run.id);
    expect(completed.status).toBe("completed");
    expect(
      completed.checkpoints.map((checkpoint) => checkpoint.status),
    ).toEqual(["running", "running", "completed"]);
    expect(completed.checkpoints.at(-1)?.output).toMatchObject({
      text: expect.stringContaining('"terminalOutcome":"verified"'),
    });
  });
});
