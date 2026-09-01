import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a clone can do before anybody has configured it.
 *
 * Everything here is a property of the repository rather than of the machine it was cloned onto, and
 * each one has already shipped broken once: a dependency only a non-workspace package declared, so
 * nothing at the root resolved it, and a tenant package that named an environment variable, so
 * loading it needed a `.env` that a clone does not have. Both left `bun run test` failing for
 * everybody except the person who added them, whose checkout was already configured.
 */

const root = join(import.meta.dir, "..");

function manifest(path: string) {
  return JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")) as {
    workspaces?: string[];
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

const rootManifest = manifest(".");
const workspaces = rootManifest.workspaces ?? [];

/** Packages with their own manifest that the root install does not reach. */
const OUTSIDE_THE_WORKSPACES = [
  "agent-bot",
  "agent-computer",
  "agent-langgraph",
  "supervisor",
] as const;

const LOADED_BY_ROOT_TESTS: Record<
  (typeof OUTSIDE_THE_WORKSPACES)[number],
  readonly string[]
> = {
  "agent-bot": ["@ag-ui/core", "@ag-ui/encoder", "openai"],
  "agent-computer": ["yaml"],
  "agent-langgraph": ["@ag-ui/core", "@langchain/core"],
  supervisor: [],
};

describe("a clone that has only run bun install", () => {
  test.each(OUTSIDE_THE_WORKSPACES)(
    "can resolve everything %s imports in its tests",
    (packageName) => {
      // These are not workspace members, so their own node_modules is never installed by the root.
      // Anything their tested source imports has to be resolvable from the root instead.
      expect(workspaces).not.toContain(packageName);

      const declared = Object.keys(manifest(packageName).dependencies ?? {});
      const rootHas = {
        ...(rootManifest.dependencies ?? {}),
        ...(rootManifest.devDependencies ?? {}),
      };

      // Only what the root test run actually loads. Some service entry points are exercised in a
      // child process, while dependencies used only inside a container remain image-local.
      for (const name of LOADED_BY_ROOT_TESTS[packageName]) {
        expect(declared).toContain(name);
        expect(rootHas).toHaveProperty(name);
      }
    },
  );

  test("can read the example tenant package with nothing set", () => {
    // `pretest` loads this package, so a name here with no fallback fails the suite before a single
    // test runs.
    const agents = readFileSync(
      join(root, "examples/fintech/agents.yaml"),
      "utf8",
    );
    const referenced = [
      ...agents.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g),
    ];

    expect(referenced.length).toBeGreaterThan(0);
    for (const [, name, rest] of referenced) {
      expect(
        rest.startsWith(":-"),
        `\${${name}} in agents.yaml has no fallback, so a clone with no .env cannot read it`,
      ).toBe(true);
    }
  });

  test("keeps every .env variant out of the repository", () => {
    // A backup taken beside .env carried live keys into a commit once.
    const ignored = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignored).toContain(".env.*");
    expect(ignored).toContain("!.env.example");
  });
});
