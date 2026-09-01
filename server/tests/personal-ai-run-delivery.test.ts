import { describe, expect, test } from "bun:test";
import {
  mintRunAssertion,
  readRunAssertion,
} from "../src/agents/callback-token";
import { PersonalAiConnectionRequiredError } from "../src/ai-connections/leases";
import {
  actorAdmissionKey,
  createPersonalAiRunGovernorForActor,
  PERSONAL_AI_SETTINGS_GUIDANCE,
  trustedRunDepth,
} from "../src/ai-connections/run-delivery";

const KEY = "test-deployment-encryption-key-with-enough-entropy";
const MANAGED_ENDPOINT = "http://agent-codex:4202/ag-ui";

describe("personal AI governed run delivery", () => {
  test("mints for the trusted actor closure and returns only opaque server fields", async () => {
    const minted: unknown[] = [];
    const govern = createPersonalAiRunGovernorForActor({
      actorUserId: "actor-owner",
      encryptionKey: KEY,
      managedAgentEndpoint: MANAGED_ENDPOINT,
      leases: {
        mint: async (input) => {
          minted.push(input);
          return "00000000-0000-4000-8000-000000000017";
        },
      },
      now: () => 1_000,
    });

    const result = await govern({
      botId: "research-analyst",
      endpoint: MANAGED_ENDPOINT,
      runId: "run-17",
      threadId: "thread-17",
      forwardedProps: {
        actorUserId: "browser-actor",
        openbotRun: "browser-run",
        openbotCredentialLease: "browser-lease",
        openbotAdmissionKey: "browser-admission",
      },
    });

    expect(minted).toEqual([
      {
        actorUserId: "actor-owner",
        botId: "research-analyst",
        runId: "run-17",
      },
    ]);
    expect(result.openbotCredentialLease).toBe(
      "00000000-0000-4000-8000-000000000017",
    );
    expect(result.openbotAdmissionKey).toBe(
      actorAdmissionKey("actor-owner", KEY),
    );
    expect(result.openbotAdmissionKey).not.toContain("actor-owner");
    expect(readRunAssertion(result.openbotRun, KEY, 1_001)).toEqual({
      actorId: "actor-owner",
      botId: "research-analyst",
      runId: "run-17",
      threadId: "thread-17",
      depth: 0,
    });
  });

  test("keeps a verified handoff depth but signs the actual run and trusted actor", async () => {
    const first = mintRunAssertion(
      {
        actorId: "actor-owner",
        botId: "research-analyst",
        runId: "handoff-placeholder",
        threadId: "asking-thread",
        depth: 2,
      },
      KEY,
      1_000,
    );
    const govern = createPersonalAiRunGovernorForActor({
      actorUserId: "actor-owner",
      encryptionKey: KEY,
      managedAgentEndpoint: MANAGED_ENDPOINT,
      leases: { mint: async () => "00000000-0000-4000-8000-000000000002" },
      now: () => 2_000,
    });

    const result = await govern({
      botId: "research-analyst",
      endpoint: MANAGED_ENDPOINT,
      runId: "platform-run",
      threadId: "answer-thread",
      forwardedProps: { openbotRun: first },
    });

    expect(readRunAssertion(result.openbotRun, KEY, 2_001)).toEqual({
      actorId: "actor-owner",
      botId: "research-analyst",
      runId: "platform-run",
      threadId: "answer-thread",
      depth: 2,
    });
  });

  test("does not accept a signed handoff depth from another actor or Bot", async () => {
    const otherRun = mintRunAssertion(
      {
        actorId: "other-actor",
        botId: "other-bot",
        runId: "other-run",
        threadId: "other-thread",
        depth: 7,
      },
      KEY,
      1_000,
    );
    const govern = createPersonalAiRunGovernorForActor({
      actorUserId: "actor-owner",
      encryptionKey: KEY,
      managedAgentEndpoint: MANAGED_ENDPOINT,
      leases: { mint: async () => "00000000-0000-4000-8000-000000000004" },
      now: () => 2_000,
    });

    const result = await govern({
      botId: "research-analyst",
      endpoint: MANAGED_ENDPOINT,
      runId: "real-run",
      threadId: "real-thread",
      forwardedProps: { openbotRun: otherRun },
    });

    expect(readRunAssertion(result.openbotRun, KEY, 2_001)?.depth).toBe(0);
  });

  test("returns exact Settings guidance when the actor has no active connection", async () => {
    const govern = createPersonalAiRunGovernorForActor({
      actorUserId: "actor-without-provider",
      encryptionKey: KEY,
      managedAgentEndpoint: MANAGED_ENDPOINT,
      leases: {
        mint: async () => {
          throw new PersonalAiConnectionRequiredError();
        },
      },
    });

    await expect(
      govern({
        botId: "research-analyst",
        endpoint: MANAGED_ENDPOINT,
        runId: "run-without-provider",
        threadId: "thread-without-provider",
        forwardedProps: {},
      }),
    ).rejects.toThrow(PERSONAL_AI_SETTINGS_GUIDANCE);
  });

  test("admission keys are stable per actor and unlinkable by raw identifier", () => {
    const first = actorAdmissionKey("actor-one", KEY);
    expect(first).toBe(actorAdmissionKey("actor-one", KEY));
    expect(first).not.toBe(actorAdmissionKey("actor-two", KEY));
    expect(first).not.toContain("actor-one");
    expect(first).toMatch(/^oba_[A-Za-z0-9_-]{43}$/);
  });

  test("does not mint or attach personal credentials to a customer-owned endpoint", async () => {
    let mintCalls = 0;
    const govern = createPersonalAiRunGovernorForActor({
      actorUserId: "actor-owner",
      encryptionKey: KEY,
      managedAgentEndpoint: MANAGED_ENDPOINT,
      leases: {
        mint: async () => {
          mintCalls += 1;
          throw new Error("must not mint");
        },
      },
    });

    await expect(
      govern({
        botId: "customer-agent",
        endpoint: "https://customer-agent.example/ag-ui",
        runId: "customer-run",
        threadId: "customer-thread",
        forwardedProps: {},
      }),
    ).resolves.toBeUndefined();
    expect(mintCalls).toBe(0);
  });

  test("carries handoff depth only for the exact trusted actor and Bot", () => {
    const signed = mintRunAssertion(
      {
        actorId: "actor-owner",
        botId: "research-analyst",
        runId: "source-run",
        depth: 3,
      },
      KEY,
      1_000,
    );
    const assertion = readRunAssertion(signed, KEY, 1_001);

    expect(trustedRunDepth(assertion, "actor-owner", "research-analyst")).toBe(
      3,
    );
    expect(trustedRunDepth(assertion, "other-actor", "research-analyst")).toBe(
      0,
    );
    expect(trustedRunDepth(assertion, "actor-owner", "other-bot")).toBe(0);
  });
});
