import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalRootsFromEnvironment,
  filterDeclaredTools,
  loadCanonicalSkillRoot,
  ManacostTeamRefusedError,
  mintManacostApproval,
  readManacostApproval,
} from "../src/plugins/manacost-team";

const KEY = "manacost-team-test-key";
const COMMIT = "a".repeat(40);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("ManacostTeam canonical skill bridge", () => {
  test("loads namespaced skills only when the pinned hashes match", async () => {
    const root = await mkdtemp(join(tmpdir(), "manacost-skills-"));
    try {
      const instructions = "# Demo\nUse the granted tool only.";
      const manifest = JSON.stringify({
        schemaVersion: 1,
        repo: "https://github.com/Manacost-Labs/skills",
        commit: COMMIT,
        skills: [
          {
            id: "core/demo",
            title: "Demo",
            summary: "A test skill",
            path: "core/demo/SKILL.md",
            sha256: hash(instructions),
            tools: ["parser-ops/audit_all_sources"],
          },
        ],
      });
      await mkdir(join(root, "core/demo"), { recursive: true });
      await writeFile(join(root, "core/demo/SKILL.md"), instructions, "utf8");
      await writeFile(join(root, "manifest.json"), manifest, "utf8");

      const [skill] = await loadCanonicalSkillRoot({
        id: "server-skills",
        root,
        repo: "https://github.com/Manacost-Labs/skills",
        commit: COMMIT,
        manifestSha256: hash(manifest),
      });

      expect(skill?.slug).toBe("core/demo");
      expect(skill?.instructions).toBe(instructions);
      expect(skill?.tools).toEqual(["parser-ops/audit_all_sources"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a path traversal before reading a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "manacost-skills-"));
    try {
      const manifest = JSON.stringify({
        schemaVersion: 1,
        repo: "repo",
        commit: COMMIT,
        skills: [
          {
            id: "core/escape",
            title: "Escape",
            summary: "Invalid",
            path: "../outside.md",
            sha256: "0".repeat(64),
          },
        ],
      });
      await writeFile(join(root, "manifest.json"), manifest, "utf8");

      await expect(
        loadCanonicalSkillRoot({
          id: "server-skills",
          root,
          repo: "repo",
          commit: COMMIT,
          manifestSha256: hash(manifest),
        }),
      ).rejects.toBeInstanceOf(ManacostTeamRefusedError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ManacostTeam policy helpers", () => {
  test("never lets a skill declaration grant an ungranted tool", () => {
    expect(
      filterDeclaredTools(
        ["parser-ops/audit_all_sources", "drive/read_file"],
        new Set(["drive/read_file"]),
      ),
    ).toEqual(["drive/read_file"]);
  });

  test("keeps approvals signed, short-lived and one-action scoped", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const signed = mintManacostApproval(
      { runId, action: "publish" },
      KEY,
      1_000,
      1_000,
    );
    expect(readManacostApproval(signed.token, KEY, 1_500)).toMatchObject({
      runId,
      action: "publish",
    });
    expect(readManacostApproval(signed.token, KEY, 2_000)).toBeNull();
    expect(readManacostApproval(`${signed.token}x`, KEY, 1_500)).toBeNull();
  });

  test("parses only server-owned canonical roots", () => {
    expect(
      canonicalRootsFromEnvironment({
        MANACOST_CANONICAL_SKILL_MANIFESTS: JSON.stringify([
          {
            id: "server",
            root: "/srv/projects/tools/skills",
            repo: "repo",
            commit: COMMIT,
            manifestSha256: "0".repeat(64),
          },
        ]),
      }),
    ).toHaveLength(1);
    expect(() =>
      canonicalRootsFromEnvironment({
        MANACOST_CANONICAL_SKILL_MANIFESTS: "not-json",
      }),
    ).toThrow(ManacostTeamRefusedError);
  });
});
