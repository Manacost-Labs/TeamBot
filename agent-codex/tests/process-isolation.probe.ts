import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import readline from "node:readline";
import {
  createOpenRouterCredentialBroker,
  type OpenRouterCredentialBroker,
} from "../src/openrouter-credential-broker";
import { createOpenRouterRuntimeProfile } from "../src/runtime-profile";

const CODEX =
  "/opt/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
const KEY = `fixture-process-isolation-${randomUUID()}`;
const SIBLING_KEY = `fixture-process-isolation-${randomUUID()}`;

async function fixtureBroker(key: string): Promise<OpenRouterCredentialBroker> {
  return createOpenRouterCredentialBroker({
    apiKey: key,
    fetch: async (input) => {
      const request = new Request(input);
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        return new Response(null, { status: 401 });
      }
      return Response.json({
        object: "list",
        data: [
          {
            id: "openrouter/probe-model",
            object: "model",
            created: 1,
            owned_by: "fixture",
          },
        ],
      });
    },
  });
}

const brokerA = await fixtureBroker(KEY);
const brokerB = await fixtureBroker(SIBLING_KEY);

const profileA = await createOpenRouterRuntimeProfile({
  broker: brokerA,
  environment: {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    RESEARCH_SOURCES_URL: "http://research-sources:8777",
    RESEARCH_SOURCE_GATEWAY_TOKEN: "fixture-research-token",
  },
  additionalEnvironmentKeys: [
    "RESEARCH_SOURCES_URL",
    "RESEARCH_SOURCE_GATEWAY_TOKEN",
  ],
});
const profileB = await createOpenRouterRuntimeProfile({
  broker: brokerB,
  environment: { PATH: process.env.PATH, LANG: "C.UTF-8" },
});

const children = [profileA, profileB].map((profile) =>
  spawn(CODEX, ["app-server", "--strict-config", "--stdio"], {
    env: profile.environment,
    stdio: ["pipe", "pipe", "pipe"],
  }),
);
const childErrors = children.map(() => "");
children.forEach((child, index) => {
  child.stderr.on("data", (chunk) => {
    childErrors[index] = `${childErrors[index]}${String(chunk)}`
      .split(KEY)
      .join("[redacted]")
      .slice(-2_000);
  });
});

function requestClient(child: (typeof children)[number]) {
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    {
      method: string;
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: unknown;
    };
    if (message.id === undefined) return;
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error)
      operation.reject(
        new Error(
          `Codex ${operation.method} probe RPC failed: ${JSON.stringify(message.error).split(KEY).join("[redacted]")}`,
        ),
      );
    else operation.resolve(message.result ?? {});
  });
  return {
    request(id: number, method: string, params: Record<string, unknown>) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { method, resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method: string, params: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    close() {
      lines.close();
    },
  };
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Codex isolation ${phase} probe timed out: ${childErrors.join(" | ")}`,
              ),
            ),
          60_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function stopChild(child: (typeof children)[number]): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const graceful = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!graceful) {
    child.kill("SIGKILL");
    await stopped;
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

const client = requestClient(children[0]);
try {
  await bounded(
    client.request(1, "initialize", {
      clientInfo: { name: "openbot-isolation-probe", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    }),
    "initialize",
  );
  client.notify("initialized", {});
  const thread = await bounded(
    client.request(2, "thread/start", {
      model: "openrouter/probe-model",
      cwd: tmpdir(),
      approvalPolicy: "never",
      permissions: "openbot-agent",
      baseInstructions: "Start no turn.",
      ephemeral: true,
      serviceName: "manacost_process_isolation_probe",
      dynamicTools: [],
    }),
    "thread/start",
  );
  const command = await bounded(
    client.request(3, "command/exec", {
      command: [
        process.execPath,
        "-e",
        `const fs=require("fs");let sharedProfileReadable=false;try{for(const name of fs.readdirSync(${JSON.stringify(dirname(profileA.codexHome))})){try{fs.readFileSync(${JSON.stringify(dirname(profileA.codexHome))}+"/"+name+"/config.toml");sharedProfileReadable=true}catch{}}}catch{}console.log(JSON.stringify({key:process.env.OPENROUTER_API_KEY!==undefined,research:process.env.RESEARCH_SOURCE_GATEWAY_TOKEN==="fixture-research-token",sharedProfileReadable}))`,
      ],
      cwd: tmpdir(),
      permissionProfile: "openbot-agent",
      timeoutMs: 5_000,
    }),
    "command/exec",
  );
  const commandOutput = String(command.stdout ?? "");
  if (!commandOutput) {
    throw new Error(
      `Codex isolation command probe failed: ${JSON.stringify(command).split(KEY).join("[redacted]")}`,
    );
  }
  const commandEnvironment = JSON.parse(commandOutput);
  const processMetadata = children.flatMap((child) =>
    ["environ", "cmdline"].map((name) => {
      try {
        return readFileSync(`/proc/${child.pid}/${name}`);
      } catch {
        return Buffer.alloc(0);
      }
    }),
  );
  const profileFiles = readdirSync(dirname(profileA.codexHome)).flatMap(
    (name) => {
      try {
        return readdirSync(`${dirname(profileA.codexHome)}/${name}`);
      } catch {
        return [];
      }
    },
  );
  const result = {
    siblingSecretAbsentFromCommand: processMetadata.every(
      (value) => !value.includes(SIBLING_KEY),
    ),
    providerTokenFilesAbsent: !profileFiles.includes("openrouter-token"),
    providerProfilesHiddenFromCommand:
      commandEnvironment.sharedProfileReadable === false,
    threadStarted:
      typeof (thread.thread as { id?: unknown } | undefined)?.id === "string",
    providerKeyHiddenFromCommand: commandEnvironment.key === false,
    providerKeyHiddenFromCommandProc: processMetadata.every(
      (value) => !value.includes(KEY),
    ),
    researchGatewayAvailable: commandEnvironment.research === true,
  };
  if (Object.values(result).some((value) => value !== true))
    process.exitCode = 1;
  console.log(JSON.stringify(result));
} finally {
  client.close();
  await Promise.all(children.map(stopChild));
  await Promise.all([
    profileA.dispose(),
    profileB.dispose(),
    brokerA.close(),
    brokerB.close(),
  ]);
}
