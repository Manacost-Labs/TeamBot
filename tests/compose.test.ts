import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function composeService(compose: string, name: string): string {
  const service = compose
    .split(/^ {2}(?=\S)/m)
    .find((block) => block.startsWith(`${name}:`));
  if (!service) throw new Error(`Expected Compose service ${name}`);
  return service;
}

test("provides PostgreSQL with pgvector for local development", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  expect(compose).toContain("postgres:");
  expect(compose).toContain("pgvector/pgvector:");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
  expect(compose).toContain("${POSTGRES_PORT:-5432}:5432");
});

/**
 * Every published port is settable, and defaults to the number the documentation gives.
 *
 * `scripts/start.sh` reads these same names to decide where to look for each service.
 */
test("publishes every service on a settable port with the documented default", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  const published = [
    ["POSTGRES_PORT", "5432", "5432"],
    ["COMPUTER_PORT", "4100", "4100"],
    ["SUPERVISOR_PORT", "4500", "4300"],
    ["BOT_PORT", "4200", "4200"],
    ["LANGGRAPH_PORT", "4201", "4201"],
  ] as const;

  for (const [name, host, container] of published) {
    expect(compose).toContain(`\${${name}:-${host}}:${container}`);
  }
});

/**
 * The services that answer to a secret are published to the host's loopback and no further.
 *
 * A published port with no interface in front of it binds every address the host has, so the
 * service answers anything that can route to the machine. That is the wrong default for all of
 * these and worst for the supervisor, which holds the Docker socket: reaching it is root on the
 * host by way of four verbs, and `SUPERVISOR_TOKEN` is a shared secret rather than a network
 * boundary. The computer says the same thing about itself in a comment beside its own port, and
 * this is that reasoning applied to every service that has one.
 *
 * Named ports rather than a blanket rule, so adding a service is a decision about where it should
 * answer rather than something this test quietly grants.
 */
test("publishes every service that holds a secret on loopback only", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  for (const name of [
    "SUPERVISOR_PORT",
    "COMPUTER_PORT",
    "BOT_PORT",
    "LANGGRAPH_PORT",
  ]) {
    const published = compose.match(
      new RegExp(`^\\s*- "(.*)\\$\\{${name}:-\\d+\\}:\\d+"`, "m"),
    );
    expect(published).not.toBeNull();
    expect(published?.[1]).toBe("127.0.0.1:");
  }
});

/**
 * Both Bots are reachable at whatever `OPENAI_BASE_URL` names.
 *
 * The API server reads that variable from `.env` directly, so it moves with the deployment. The
 * Bots run in containers and see only what compose hands them, and a deployment that moved its
 * models to a gateway and found half of itself still calling OpenAI would have no way to tell.
 */
test("gives both shipped Bots the OpenAI-compatible endpoint", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  // Both Bots speak OpenAI; only the framework Bot can be pointed at the other two.
  expect(
    compose.match(/OPENAI_BASE_URL: \$\{OPENAI_BASE_URL:-?\}/g),
  ).toHaveLength(2);
  for (const variable of [
    "ANTHROPIC_BASE_URL",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
  ]) {
    expect(compose).toContain(`${variable}: \${${variable}:-}`);
  }
});

test("enables pgvector before creating vector columns", () => {
  const migration = readFileSync(
    join(import.meta.dir, "..", "server", "drizzle", "0000_schema.sql"),
    "utf8",
  );

  // The order is the property, not the first line. A `vector` column cannot be created before the
  // extension that defines the type, and a generated migration has no reason to put them in that
  // order on its own.
  const extension = migration.indexOf("CREATE EXTENSION IF NOT EXISTS vector;");
  const firstVectorColumn = migration.search(/"embedding" vector\(/);
  expect(extension).toBeGreaterThanOrEqual(0);
  expect(firstVectorColumn).toBeGreaterThan(extension);
});

test("runs migrations after PostgreSQL becomes healthy", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  expect(compose).toContain("migrate:");
  expect(compose).toContain("condition: service_healthy");
  expect(compose).toContain('"drizzle-kit", "migrate"');
});

/**
 * Per-Bot egress reaches the processes that read it.
 *
 * `EGRESS_PROXY_<BOT>` and `EGRESS_PROXY_DEFAULT` are resolved from `process.env` by the computer
 * itself (`agent-computer/src/egress.ts`), and the supervisor forwards every `EGRESS_PROXY` key out
 * of its own environment into each computer it creates (`supervisor/src/index.ts`). Compose gives a
 * container only what its `environment:` and `env_file:` blocks name, and for a long time neither
 * named these, so an operator who configured a proxy per the documentation got a browser that went
 * out directly and no error saying so.
 *
 * A file rather than `environment:` entries because the names are per-Bot and therefore not knowable
 * here, and a file of its own rather than `.env` because that one holds the deployment's secrets and
 * the browser container is deliberately not given them.
 */
test("carries per-Bot egress into the computer and the supervisor", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  // Both halves: the shared computer reads them itself, and the supervisor passes them on.
  const services = compose.split(/^ {2}(?=\S)/m);
  for (const name of ["agent-computer:", "supervisor:"]) {
    const service = services.find((block) => block.startsWith(name));
    expect(service).toBeDefined();
    expect(service).toContain("egress.env");
  }

  // Optional, because a deployment with no proxy is the ordinary case and must still start.
  expect(compose).toContain("required: false");
});

test("mounts durable attachment storage only into the production API server", () => {
  const production = readFileSync(
    join(import.meta.dir, "..", "docker-compose.production.yml"),
    "utf8",
  );
  const openbot = composeService(production, "openbot");

  expect(openbot).toContain(
    "ATTACHMENT_STORAGE_DIR: /var/lib/openbot/attachments",
  );
  expect(openbot).toContain(
    "ATTACHMENT_MAX_BYTES: $" + "{ATTACHMENT_MAX_BYTES:-26214400}",
  );
  expect(openbot).toContain("openbot-attachments:/var/lib/openbot/attachments");
  expect(production).toMatch(/^ {2}openbot-attachments:\s*$/m);

  const parsed = parse(production) as {
    services?: Record<
      string,
      {
        cap_add?: string[];
        cap_drop?: string[];
        command?: string[];
        depends_on?: Record<string, { condition?: string }>;
        entrypoint?: string[];
        environment?: Record<string, string>;
        healthcheck?: { test?: string[] };
        image?: string;
        network_mode?: string;
        read_only?: boolean;
        restart?: string;
        user?: string;
        volumes?: string[];
        working_dir?: string;
      }
    >;
  };
  const storageInit = parsed.services?.["attachment-storage-init"];
  expect(storageInit).toBeDefined();
  expect(storageInit?.user).toBe("0:0");
  expect(storageInit?.restart).toBe("no");
  expect(storageInit?.network_mode).toBe("none");
  expect(storageInit?.read_only).toBe(true);
  expect(storageInit?.cap_drop).toEqual(["ALL"]);
  expect(storageInit?.cap_add).toEqual(["CHOWN", "FOWNER"]);
  expect(storageInit?.volumes).toEqual([
    "openbot-attachments:/var/lib/openbot/attachments",
  ]);
  expect(storageInit?.command?.join(" ")).toContain(
    "chmod 0700 /var/lib/openbot/attachments",
  );
  expect(storageInit?.command?.join(" ")).toContain(
    "chown pwuser:pwuser /var/lib/openbot/attachments",
  );
  expect(
    parsed.services?.openbot?.depends_on?.["attachment-storage-init"]
      ?.condition,
  ).toBe("service_completed_successfully");

  const api = parsed.services?.openbot;
  const computer = parsed.services?.["agent-computer"];
  expect(api?.environment?.EMBEDDED_COMPUTER).toBe("off");
  expect(api?.environment?.AGENT_COMPUTER_URL).toBe(
    "http://agent-computer:4100",
  );
  expect(api?.depends_on?.["agent-computer"]?.condition).toBe(
    "service_healthy",
  );
  expect(api?.volumes).not.toContain("openbot-workspace:/workspace");
  expect(api?.volumes).not.toContain("openbot-profiles:/profiles");

  expect(computer?.image).toBe("openbot-work:local");
  expect(computer?.user).toBe("pwuser:pwuser");
  expect(computer?.working_dir).toBe("/app");
  expect(computer?.entrypoint).toEqual([
    "/usr/local/bin/bun",
    "agent-computer/src/index.ts",
  ]);
  expect(computer?.environment?.PORT).toBe("4100");
  expect(computer?.environment?.COMPUTER_TOKEN).toContain("COMPUTER_TOKEN");
  expect(computer?.healthcheck?.test?.join(" ")).toContain(
    "http://127.0.0.1:4100/health",
  );
  expect(computer?.volumes).toEqual([
    "openbot-workspace:/workspace",
    "openbot-profiles:/profiles",
  ]);

  for (const serviceName of [
    "routine-worker",
    "agent-computer",
    "agent-codex",
    "research-sources",
    "editor-analyzer",
    "editor-gateway",
    "edge-auth",
  ]) {
    const service = composeService(production, serviceName);
    expect(service).not.toContain("openbot-attachments");
    expect(service).not.toContain("/var/lib/openbot/attachments");
    expect(service).not.toContain("ATTACHMENT_STORAGE_DIR");
  }
});

test("shares research provider credentials only with OpenBot and agent runtimes", () => {
  const production = readFileSync(
    join(import.meta.dir, "..", "docker-compose.production.yml"),
    "utf8",
  );
  const parsed = parse(production, { merge: true }) as {
    services?: Record<string, { environment?: Record<string, string> }>;
  };
  const expected = {
    REDDITAPIS_KEY:
      "$" + "{RESEARCH_REDDITAPIS_KEY:?RESEARCH_REDDITAPIS_KEY is required}",
    GETXAPI_KEY:
      "$" + "{RESEARCH_GETXAPI_KEY:?RESEARCH_GETXAPI_KEY is required}",
    TRANSCRIPTAPI_TOKEN: "$" + "{RESEARCH_TRANSCRIPTAPI_TOKEN:-}",
    TINYFISH_API_KEY:
      "$" +
      "{RESEARCH_TINYFISH_API_KEY:?RESEARCH_TINYFISH_API_KEY is required}",
  };

  for (const serviceName of ["openbot", "agent-codex", "research-sources"]) {
    expect(parsed.services?.[serviceName]?.environment).toMatchObject(expected);
  }

  for (const serviceName of [
    "attachment-storage-init",
    "agent-computer",
    "artifact-renderer",
    "pdf-extractor",
    "routine-worker",
    "editor-analyzer",
    "editor-gateway",
    "edge-auth",
  ]) {
    const environment = parsed.services?.[serviceName]?.environment ?? {};
    for (const variable of Object.keys(expected)) {
      expect(environment).not.toHaveProperty(variable);
    }
  }
});

test("keeps Telegram and personal provider credentials on their narrow production boundaries", () => {
  const production = readFileSync(
    join(import.meta.dir, "..", "docker-compose.production.yml"),
    "utf8",
  );
  const parsed = parse(production, { merge: true }) as {
    services?: Record<
      string,
      {
        env_file?: string | string[];
        environment?: Record<string, string>;
        tmpfs?: string[];
        volumes?: string[];
      }
    >;
  };
  const openbot = parsed.services?.openbot;
  const agent = parsed.services?.["agent-codex"];
  const routineWorker = parsed.services?.["routine-worker"];

  expect(openbot?.environment).toMatchObject({
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENBOT_SINGLE_USER: "$" + "{OPENBOT_SINGLE_USER:-false}",
    OPENBOT_PUBLIC_URL:
      "$" + "{OPENBOT_PUBLIC_URL:?OPENBOT_PUBLIC_URL is required}",
    OPENBOT_APP_URL:
      "$" + "{OPENBOT_PUBLIC_URL:?OPENBOT_PUBLIC_URL is required}",
    TRUSTED_ORIGINS:
      "$" + "{OPENBOT_PUBLIC_URL:?OPENBOT_PUBLIC_URL is required}",
    BETTER_AUTH_SECRET:
      "$" + "{BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}",
    TELEGRAM_LOGIN_BOT_USERNAME:
      "$" +
      "{TELEGRAM_LOGIN_BOT_USERNAME:?TELEGRAM_LOGIN_BOT_USERNAME is required}",
    TELEGRAM_LOGIN_BOT_TOKEN:
      "$" + "{TELEGRAM_LOGIN_BOT_TOKEN:?TELEGRAM_LOGIN_BOT_TOKEN is required}",
    TELEGRAM_ALLOWED_USER_IDS:
      "$" +
      "{TELEGRAM_ALLOWED_USER_IDS:?TELEGRAM_ALLOWED_USER_IDS is required}",
    TELEGRAM_OWNER_USER_IDS:
      "$" + "{TELEGRAM_OWNER_USER_IDS:?TELEGRAM_OWNER_USER_IDS is required}",
    MANAGED_AGENT_TOKEN:
      "$" + "{MANAGED_AGENT_TOKEN:?MANAGED_AGENT_TOKEN is required}",
  });

  expect(agent?.environment).toMatchObject({
    OPENBOT_INTERNAL_URL: "http://openbot:3001",
    MANAGED_AGENT_TOKEN:
      "$" + "{MANAGED_AGENT_TOKEN:?MANAGED_AGENT_TOKEN is required}",
    AGENT_TOOL_TOKEN: "$" + "{AGENT_TOOL_TOKEN:?AGENT_TOOL_TOKEN is required}",
    OPENROUTER_MODEL: "$" + "{OPENROUTER_MODEL:?OPENROUTER_MODEL is required}",
  });
  for (const forbidden of [
    "BETTER_AUTH_SECRET",
    "TELEGRAM_LOGIN_BOT_USERNAME",
    "TELEGRAM_LOGIN_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    "TELEGRAM_OWNER_USER_IDS",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CODEX_AUTH_PATH",
    "CODEX_HOME",
    "HOME",
  ]) {
    expect(agent?.environment).not.toHaveProperty(forbidden);
  }

  expect(agent?.volumes ?? []).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /(?:auth\.json|\/(?:home\/[^/]+\/)?\.codex)(?:\/|$)/,
      ),
    ]),
  );
  expect(agent?.tmpfs).toEqual([
    "/run/openbot-codex:size=67108864,mode=0700,uid=1000,gid=1000",
  ]);
  expect(agent?.env_file).toBeUndefined();

  for (const service of Object.values(parsed.services ?? {})) {
    const environmentFiles = Array.isArray(service.env_file)
      ? service.env_file
      : service.env_file
        ? [service.env_file]
        : [];
    expect(environmentFiles).not.toContain(".env.manacostteam-auth");
  }
  expect(routineWorker?.env_file).toBeUndefined();
  expect(routineWorker?.environment).not.toHaveProperty("OPENAI_API_KEY");
  expect(routineWorker?.environment).not.toHaveProperty("OPENROUTER_API_KEY");

  const agentDockerfile = readFileSync(
    join(import.meta.dir, "..", "agent-codex", "Dockerfile"),
    "utf8",
  );
  expect(agentDockerfile).toContain("FROM oven/bun:1.3.14-slim");
  expect(agentDockerfile).not.toContain("/home/bun/.codex");
  expect(agentDockerfile).not.toContain("auth.json");
});

test("does not expose attachment storage to local Bot or computer services", () => {
  const compose = readFileSync(
    join(import.meta.dir, "..", "docker-compose.yml"),
    "utf8",
  );

  for (const serviceName of [
    "migrate",
    "agent-computer",
    "supervisor",
    "agent-bot",
    "agent-langgraph",
  ]) {
    const service = composeService(compose, serviceName);
    expect(service).not.toContain("openbot-attachments");
    expect(service).not.toContain("/var/lib/openbot/attachments");
    expect(service).not.toContain("ATTACHMENT_STORAGE_DIR");
  }
});

test("the Helm local attachment backend is durable, singleton, and server-only", () => {
  const chartRoot = join(import.meta.dir, "..", "charts", "openbot");
  const values = parse(
    readFileSync(join(chartRoot, "values.yaml"), "utf8"),
  ) as {
    server?: {
      replicaCount?: number;
      autoscaling?: { enabled?: boolean };
      attachments?: {
        storageDirectory?: string;
        maxBytes?: number;
        persistence?: {
          enabled?: boolean;
          accessModes?: string[];
          size?: string;
        };
      };
    };
  };

  expect(values.server?.replicaCount).toBe(1);
  expect(values.server?.autoscaling?.enabled).toBe(false);
  expect(values.server?.attachments).toEqual({
    storageDirectory: "/var/lib/openbot/attachments",
    maxBytes: 26_214_400,
    persistence: {
      enabled: true,
      existingClaim: "",
      storageClass: "",
      accessModes: ["ReadWriteOnce"],
      size: "20Gi",
      annotations: {},
    },
  });

  const deployment = readFileSync(
    join(chartRoot, "templates", "server", "deployment.yaml"),
    "utf8",
  );
  for (const expected of [
    "ATTACHMENT_STORAGE_DIR",
    "ATTACHMENT_MAX_BYTES",
    "strategy:\n    type: Recreate",
    "initContainers:",
    "name: prepare-attachment-storage",
    "runAsUser: 0",
    "allowPrivilegeEscalation: false",
    "readOnlyRootFilesystem: true",
    "mountPath: {{ $attachmentDirectory | quote }}",
    "name: attachments",
  ]) {
    expect(deployment).toContain(expected);
  }
  expect(deployment).toMatch(/drop:\s*\n\s*- ALL/);
  expect(deployment).toMatch(/add:\s*\n\s*- CHOWN\s*\n\s*- FOWNER/);
  const initContainer = deployment.slice(
    deployment.indexOf("      initContainers:"),
    deployment.indexOf("      containers:"),
  );
  expect(initContainer).toContain(
    "chmod 0700 /attachment-storage && chown pwuser:pwuser /attachment-storage",
  );
  expect(initContainer).toContain("mountPath: /attachment-storage");
  expect(initContainer).not.toContain("$attachmentDirectory");

  const pvcPath = join(
    chartRoot,
    "templates",
    "server",
    "attachments-pvc.yaml",
  );
  expect(existsSync(pvcPath)).toBe(true);
  if (!existsSync(pvcPath)) return;
  const pvc = readFileSync(pvcPath, "utf8");
  expect(pvc).toContain("kind: PersistentVolumeClaim");
  expect(pvc).toContain(".Values.server.attachments");
  expect(pvc).toContain("$attachments.persistence");
  expect(pvc).toContain("helm.sh/resource-policy: keep");

  const validation = readFileSync(
    join(chartRoot, "templates", "validation.yaml"),
    "utf8",
  );
  expect(validation).toContain("server.attachments.persistence.enabled");
  expect(validation).toContain("server.replicaCount=1");
  expect(validation).toContain("server.autoscaling.enabled=false");
  expect(validation).toContain(
    "server.embeddedComputer must be false while attachments use local storage",
  );
  expect(validation).toContain(
    "server.attachments.storageDirectory must be exactly /var/lib/openbot/attachments",
  );

  for (const relative of [
    "templates/migrations/job.yaml",
    "templates/routines/cronjob.yaml",
    "templates/computer/statefulset.yaml",
    "templates/computer/pod-template.yaml",
  ]) {
    const workload = readFileSync(join(chartRoot, relative), "utf8");
    expect(workload).not.toContain("ATTACHMENT_STORAGE_DIR");
    expect(workload).not.toContain("name: attachments");
    expect(workload).not.toContain("/var/lib/openbot/attachments");
  }

  for (const target of [
    "aks-values.yaml",
    "eks-sandbox-values.yaml",
    "eks-values.yaml",
    "gke-values.yaml",
    "self-hosted-values.yaml",
  ]) {
    const targetValues = parse(
      readFileSync(join(chartRoot, "ci", target), "utf8"),
    ) as { server?: { autoscaling?: { enabled?: boolean } } };
    expect(targetValues.server?.autoscaling?.enabled).not.toBe(true);
  }

  for (const target of ["eks-sandbox-values.yaml", "eks-values.yaml"]) {
    const targetValues = parse(
      readFileSync(join(chartRoot, "ci", target), "utf8"),
    ) as {
      server?: {
        attachments?: { persistence?: { storageClass?: string } };
      };
    };
    expect(targetValues.server?.attachments?.persistence?.storageClass).toBe(
      "gp3",
    );
  }

  const readme = readFileSync(join(chartRoot, "README.md"), "utf8");
  expect(readme).not.toContain("The API tier holds nothing on disk");
  expect(readme).toContain("server.attachments.persistence.storageClass");
});

test("the Helm attachment limit keeps whole numbers out of scientific notation", () => {
  const validation = readFileSync(
    join(
      import.meta.dir,
      "..",
      "charts",
      "openbot",
      "templates",
      "validation.yaml",
    ),
    "utf8",
  );

  expect(validation).toContain(
    "$attachmentMaxBytesRaw = toJson $attachments.maxBytes",
  );
  expect(validation).not.toContain(
    '$attachmentMaxBytesRaw = printf "%v" $attachments.maxBytes',
  );
});

test("the Helm default image tag matches the current published package version", () => {
  const packageJson = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
  ) as { version: string };
  const chart = parse(
    readFileSync(
      join(import.meta.dir, "..", "charts", "openbot", "Chart.yaml"),
      "utf8",
    ),
  ) as { appVersion?: string };
  const expectedTag = `v${packageJson.version}`;

  expect(chart.appVersion).toBe(expectedTag);
  expect(
    readFileSync(
      join(import.meta.dir, "..", "charts", "openbot", "README.md"),
      "utf8",
    ),
  ).toContain(`ghcr.io/copilotkit/openbot:${expectedTag}`);
});

test("the production image gives fresh attachment volumes to the API user", () => {
  const dockerfile = readFileSync(
    join(import.meta.dir, "..", "Dockerfile"),
    "utf8",
  );

  expect(dockerfile).toContain("/var/lib/openbot/attachments");
  expect(dockerfile).toMatch(
    /chown[^\n]*pwuser:pwuser[^\n]*\/var\/lib\/openbot\/attachments/,
  );
  expect(dockerfile).toMatch(
    /chmod[^\n]*0700[^\n]*\/var\/lib\/openbot\/attachments/,
  );
});

test("raw Docker deployment keeps the computer outside the API container", () => {
  const deployment = readFileSync(
    join(import.meta.dir, "..", "docs", "deployment.md"),
    "utf8",
  );

  expect(deployment).toContain("-e EMBEDDED_COMPUTER=off");
  expect(deployment).toContain(
    "-e AGENT_COMPUTER_URL=http://openbot-computer:4100",
  );
  expect(deployment).toContain("--name openbot-computer");
  expect(deployment).toContain("agent-computer/src/index.ts");
});
