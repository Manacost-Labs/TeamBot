import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, tmpdir, totalmem } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type Page,
} from "../artifact-renderer/node_modules/playwright/index.mjs";
import { verifyChatReliability } from "./chat-reliability-browser";
import { verifyChatPolish } from "./chat-polish-browser";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureConfig = join(
  repoRoot,
  "app/tests/runtime-performance-fixture/vite.config.ts",
);
const viteBin = join(repoRoot, "app/node_modules/vite/bin/vite.js");
const chromiumExecutable =
  process.env.CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium";
const iterations = 30;
const warmups = 4;

type ScenarioId =
  | "cold_switch"
  | "first_delta"
  | "history_50"
  | "history_200"
  | "history_500"
  | "history_2000"
  | "history_10000"
  | "warm_switch";

type BrowserMeasurement = {
  elapsedMs: number;
  markerVisible: boolean;
  mountedRows: number;
};

type ScenarioDefinition = {
  id: ScenarioId;
  label: string;
  targetP95Ms: number;
};

const scenarios: readonly ScenarioDefinition[] = [
  {
    id: "warm_switch",
    label: "warm cached channel click → useful transcript paint",
    targetP95Ms: 100,
  },
  {
    id: "cold_switch",
    label: "cold channel click → useful transcript paint",
    targetP95Ms: 300,
  },
  {
    id: "first_delta",
    label: "accepted first text delta → visible transcript paint",
    targetP95Ms: 500,
  },
  {
    id: "history_50",
    label: "50-message rich history → useful transcript paint",
    targetP95Ms: 300,
  },
  {
    id: "history_200",
    label: "200-message rich history → useful transcript paint",
    targetP95Ms: 300,
  },
  {
    id: "history_500",
    label: "500-message rich history → useful transcript paint",
    targetP95Ms: 300,
  },
  {
    id: "history_2000",
    label: "2,000-message rich history → useful transcript paint",
    targetP95Ms: 450,
  },
  {
    id: "history_10000",
    label: "10,000-message rich history → useful transcript paint",
    targetP95Ms: 700,
  },
];

const profiles = [
  {
    id: "desktop",
    label: "desktop 1440×900",
    viewport: { height: 900, width: 1440 },
    cpuSlowdownRate: 1,
  },
  {
    id: "mobile",
    label: "mobile 390×844, 4× CPU slowdown",
    viewport: { height: 844, width: 390 },
    cpuSlowdownRate: 4,
  },
] as const;

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

function milliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function command(args: readonly string[]): Promise<string> {
  const process = Bun.spawn(args, {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${args.join(" ")}):\n${stdout}\n${stderr}`.trim(),
    );
  }
  return stdout.trim();
}

function contentType(pathname: string): string {
  switch (extname(pathname)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function startStaticServer(directory: string) {
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        "http://runtime-performance.local",
      );
      if (requestUrl.pathname.startsWith("/api/")) {
        response.writeHead(204, { "cache-control": "no-store" }).end();
        return;
      }
      const relative =
        requestUrl.pathname === "/"
          ? "index.html"
          : requestUrl.pathname.replace(/^\/+/, "");
      const candidate = resolve(directory, normalize(relative));
      if (!candidate.startsWith(`${resolve(directory)}/`)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(candidate);
      response.writeHead(200, { "content-type": contentType(candidate) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListening());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Static benchmark server did not expose a TCP port");
  }
  return {
    close: () =>
      new Promise<void>((resolveClosed, reject) => {
        server.close((error) => (error ? reject(error) : resolveClosed()));
      }),
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function runBrowserScenario(
  page: Page,
  scenario: ScenarioDefinition,
): Promise<BrowserMeasurement[]> {
  const invoke = async (iteration: number) => {
    const generation = await page.evaluate(
      ({ id, sample }) => {
        const benchmark = (
          window as typeof window & {
            runtimePerformanceBenchmark?: {
              prepare: (scenario: ScenarioId, iteration: number) => number;
            };
          }
        ).runtimePerformanceBenchmark;
        if (!benchmark) throw new Error("Benchmark fixture is not ready");
        return benchmark.prepare(id, sample);
      },
      { id: scenario.id, sample: iteration },
    );
    await page
      .locator("[data-runtime-performance-trigger]")
      .dispatchEvent("click");
    await page.waitForFunction((expectedGeneration) => {
      const benchmark = (
        window as typeof window & {
          runtimePerformanceBenchmark?: {
            peek: (generation: number) => BrowserMeasurement | null;
          };
        }
      ).runtimePerformanceBenchmark;
      return benchmark ? benchmark.peek(expectedGeneration) !== null : false;
    }, generation);
    return page.evaluate((expectedGeneration) => {
      const benchmark = (
        window as typeof window & {
          runtimePerformanceBenchmark?: {
            take: (generation: number) => BrowserMeasurement | null;
          };
        }
      ).runtimePerformanceBenchmark;
      const measurement = benchmark?.take(expectedGeneration) ?? null;
      if (!measurement) throw new Error("Completed measurement disappeared");
      return measurement;
    }, generation);
  };

  for (let index = 0; index < warmups; index += 1) {
    await invoke(-warmups + index);
  }

  const measurements: BrowserMeasurement[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const measurement = await invoke(index);
    if (!measurement.markerVisible) {
      throw new Error(`${scenario.id}: useful marker was not visible at paint`);
    }
    if (measurement.mountedRows < 1 || measurement.mountedRows > 60) {
      throw new Error(
        `${scenario.id}: expected a bounded 1..60 row window, got ${measurement.mountedRows}`,
      );
    }
    measurements.push(measurement);
  }
  return measurements;
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "teambot-runtime-perf-"));
  const buildOutput = join(temporaryRoot, "dist");
  let staticServer: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  const browser = await chromium.launch({
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--no-first-run",
    ],
    executablePath: chromiumExecutable,
    headless: true,
  });

  try {
    const build = Bun.spawn(
      [
        "bun",
        viteBin,
        "build",
        "--config",
        fixtureConfig,
        "--mode",
        "production",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, RUNTIME_PERF_OUT_DIR: buildOutput },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [buildStdout, buildStderr, buildExit] = await Promise.all([
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
      build.exited,
    ]);
    if (buildExit !== 0) {
      throw new Error(
        `Production fixture build failed:\n${buildStdout}\n${buildStderr}`.trim(),
      );
    }

    staticServer = await startStaticServer(buildOutput);
    let externalRequests = 0;
    const pageErrors: string[] = [];
    const results = [];
    const reliability = [];
    for (const profile of profiles) {
      const context = await browser.newContext({
        deviceScaleFactor: 1,
        locale: "ru-RU",
        viewport: profile.viewport,
      });
      const page = await context.newPage();
      try {
        const devtools = await context.newCDPSession(page);
        await devtools.send("Emulation.setCPUThrottlingRate", {
          rate: profile.cpuSlowdownRate,
        });
        page.on("pageerror", (error) => {
          pageErrors.push(error.message);
          process.stderr.write(`benchmark page error: ${error.message}\n`);
        });
        page.on("console", (message) => {
          if (message.type() === "error") {
            process.stderr.write(
              `benchmark console error: ${message.text()}\n`,
            );
          }
        });
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.hostname === "127.0.0.1") {
            await route.continue();
          } else {
            externalRequests += 1;
            await route.abort("blockedbyclient");
          }
        });
        await page.goto(staticServer.url, { waitUntil: "networkidle" });
        await page.waitForFunction(
          () =>
            (
              window as typeof window & {
                runtimePerformanceBenchmark?: unknown;
              }
            ).runtimePerformanceBenchmark !== undefined,
        );

        for (const scenario of process.argv.includes("--reliability-only")
          ? []
          : scenarios) {
          const measurements = await runBrowserScenario(page, scenario);
          const sorted = measurements
            .map((measurement) => measurement.elapsedMs)
            .sort((left, right) => left - right);
          const p95 = milliseconds(percentile(sorted, 0.95));
          const mountedRows = measurements.map(
            (measurement) => measurement.mountedRows,
          );
          const targetP95Ms =
            scenario.targetP95Ms *
            (profile.cpuSlowdownRate > 1 ? profile.cpuSlowdownRate : 1);
          results.push({
            profile: profile.id,
            profileLabel: profile.label,
            id: scenario.id,
            label: scenario.label,
            samples: measurements.length,
            targetP95Ms,
            p50Ms: milliseconds(percentile(sorted, 0.5)),
            p95Ms: p95,
            p99Ms: milliseconds(percentile(sorted, 0.99)),
            maxMs: milliseconds(sorted.at(-1) ?? 0),
            mountedRowsMin: Math.min(...mountedRows),
            mountedRowsMax: Math.max(...mountedRows),
            passed: p95 < targetP95Ms,
          });
        }
        reliability.push({
          profile: profile.id,
          ...(await verifyChatReliability(page)),
          polish: await verifyChatPolish(page, profile.id),
        });
      } finally {
        await context.close();
      }
    }

    if (pageErrors.length > 0) {
      throw new Error(`Browser page errors:\n${pageErrors.join("\n")}`);
    }

    const [commit, dirty, indexStats] = await Promise.all([
      command(["git", "rev-parse", "HEAD"]),
      command(["git", "status", "--porcelain"]),
      stat(join(buildOutput, "index.html")),
    ]);
    const report = {
      schema: "teambot.runtime-performance.v1",
      generatedAt: new Date().toISOString(),
      revision: { commit, worktreeDirty: dirty.length > 0 },
      method: {
        build: "Vite production mode, minified",
        browser: `${browser.browserType().name()} ${browser.version()}`,
        chromiumExecutable,
        externalRequests,
        fixtureIndexBytes: indexStats.size,
        iterationsPerScenario: iterations,
        warmupsPerScenario: warmups,
        paintBoundary:
          "React commit followed by two requestAnimationFrame callbacks",
        scope:
          "Local production UI bundle and real Chromium; excludes authentication, provider and network latency",
        profiles: profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          viewport: `${profile.viewport.width}x${profile.viewport.height} @ 1x`,
          cpuSlowdownRate: profile.cpuSlowdownRate,
        })),
      },
      machine: {
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      results,
      reliability,
      passed: results.every((result) => result.passed),
    };

    const json = `${JSON.stringify(report, null, 2)}\n`;
    process.stdout.write(json);
    const jsonIndex = process.argv.indexOf("--json");
    const requestedOutput = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;
    if (requestedOutput) {
      await Bun.write(resolve(repoRoot, requestedOutput), json);
    }
    if (!report.passed) process.exitCode = 1;
  } finally {
    await browser.close();
    await staticServer?.close();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await main();
