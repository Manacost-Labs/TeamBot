import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { OpenRouterCredentialBroker } from "./openrouter-credential-broker";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TRUSTED_RUNTIME_CONFIG = new URL("../config.toml", import.meta.url);

export const OPENROUTER_API_KEY_ENVIRONMENT_KEY = "OPENROUTER_API_KEY";

const OPENROUTER_ROOT_CONFIG = 'model_provider = "manacost_openrouter"';
const DEFAULT_PROFILE_ROOT = join(tmpdir(), "openbot-codex-profiles");

function openRouterTableConfig(baseUrl: string) {
  return `[model_providers.manacost_openrouter]
name = "OpenRouter"
base_url = "${baseUrl}"
wire_api = "responses"
requires_openai_auth = false

[shell_environment_policy]
inherit = "all"
ignore_default_excludes = true
exclude = ["${OPENROUTER_API_KEY_ENVIRONMENT_KEY}"]
include_only = [
  "PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM",
  "NO_COLOR", "FORCE_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy",
  "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "RESEARCH_SOURCES_URL", "RESEARCH_SOURCE_GATEWAY_TOKEN",
]
`;
}

/**
 * Process settings needed by the Codex binary itself. Authentication and application credentials
 * are deliberately absent: a caller must opt in to any additional, task-scoped variable by name.
 */
const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export type CodexRuntimeProfile = {
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
};

export type CreateCodexRuntimeProfileOptions = {
  environment?: NodeJS.ProcessEnv;
  parentDirectory?: string;
  additionalEnvironmentKeys?: readonly string[];
};

export type CreateOpenRouterRuntimeProfileOptions = Omit<
  CreateCodexRuntimeProfileOptions,
  "additionalEnvironmentKeys"
> & {
  /** Adapter-owned broker; runtime validation rejects non-loopback or weak capability URLs. */
  broker: Pick<OpenRouterCredentialBroker, "baseUrl">;
  /** Runtime-owned task variables; filtered again so callers cannot expand the environment. */
  additionalEnvironmentKeys?: readonly string[];
};

const OPENROUTER_TASK_ENVIRONMENT_KEYS = new Set([
  "RESEARCH_SOURCES_URL",
  "RESEARCH_SOURCE_GATEWAY_TOKEN",
]);

function validBrokerBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    /^(?:[1-9][0-9]{0,4})$/.test(parsed.port) &&
    Number(parsed.port) <= 65_535 &&
    parsed.username === "" &&
    parsed.password === "" &&
    /^\/[A-Za-z0-9_-]{43}\/v1$/.test(parsed.pathname) &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}

function trustedRuntimeConfig(source: string, profileRoot: string): string {
  // Codex 0.144 rejects this one flag while the production image is pinned to 0.150. Keep every
  // other explicit security disablement in the isolated profile so a compatibility workaround
  // cannot silently re-enable apps, plugins, browser/computer access or multi-agent execution.
  const lines: string[] = [];
  let inFeatures = false;
  for (const line of source.split("\n")) {
    if (/^\[permissions\.[^.]+\.filesystem\]$/.test(line.trim())) {
      lines.push(line, `${JSON.stringify(profileRoot)} = "deny"`);
      continue;
    }
    if (line.trim() === "[features]") {
      inFeatures = true;
      lines.push(line);
      continue;
    }
    if (inFeatures && line.trim().startsWith("[")) {
      inFeatures = false;
    }
    if (
      inFeatures &&
      /^(?:in_app_local_automation|skill_search)\s*=/.test(line.trim())
    )
      continue;
    lines.push(line);
  }
  return lines.join("\n");
}

async function secureProfileRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.length > 512) {
    throw new Error("Codex profile root is invalid.");
  }
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  const uid = process.getuid?.();
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    uid === undefined ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error("Codex profile root is unavailable.");
  }
  return path;
}

export function buildCodexChildEnvironment(
  environment: NodeJS.ProcessEnv,
  options: {
    codexHome?: string;
    additionalEnvironmentKeys?: readonly string[];
  } = {},
): NodeJS.ProcessEnv {
  const allowedKeys = new Set<string>([
    ...BASE_ENVIRONMENT_KEYS,
    ...(options.additionalEnvironmentKeys ?? []),
  ]);
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = environment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  if (options.codexHome) childEnvironment.CODEX_HOME = options.codexHome;
  return childEnvironment;
}

/** Create one task-owned profile. The returned disposer is safe to call more than once. */
export async function createCodexRuntimeProfile(
  options: CreateCodexRuntimeProfileOptions = {},
): Promise<CodexRuntimeProfile> {
  const parentDirectory = await secureProfileRoot(
    options.parentDirectory ??
      process.env.CODEX_PROFILE_ROOT ??
      DEFAULT_PROFILE_ROOT,
  );
  const codexHome = await mkdtemp(join(parentDirectory, "openbot-codex-"));
  let disposed = false;

  try {
    await chmod(codexHome, PRIVATE_DIRECTORY_MODE);
    const configPath = join(codexHome, "config.toml");
    const trustedConfig = trustedRuntimeConfig(
      await readFile(TRUSTED_RUNTIME_CONFIG, "utf8"),
      parentDirectory,
    );
    await writeFile(configPath, trustedConfig, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(configPath, PRIVATE_FILE_MODE);
    return {
      codexHome,
      environment: buildCodexChildEnvironment(
        options.environment ?? process.env,
        {
          codexHome,
          additionalEnvironmentKeys: options.additionalEnvironmentKeys,
        },
      ),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(codexHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(codexHome, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Create the fixed OpenRouter Responses provider understood by the installed Codex CLI.
 *
 * Only a validated per-run loopback capability is serialized. The OpenRouter key remains in the
 * adapter-owned broker and never enters the child environment, command line, filesystem or config.
 * The generated permissions still deny the shared profile root.
 */
export async function createOpenRouterRuntimeProfile(
  options: CreateOpenRouterRuntimeProfileOptions,
): Promise<CodexRuntimeProfile> {
  if (!validBrokerBaseUrl(options.broker.baseUrl)) {
    throw new Error("OpenRouter credential broker is unavailable.");
  }

  const profile = await createCodexRuntimeProfile({
    environment: options.environment,
    parentDirectory: options.parentDirectory,
    additionalEnvironmentKeys: (options.additionalEnvironmentKeys ?? []).filter(
      (key) => OPENROUTER_TASK_ENVIRONMENT_KEYS.has(key),
    ),
  });
  try {
    const configPath = join(profile.codexHome, "config.toml");
    const trustedConfig = await readFile(configPath, "utf8");
    // TOML has no syntax for returning to the root table. The selected provider must therefore be
    // written before the first `[table]`; appending it after the permissions tables silently makes
    // it a permission-network field and leaves the default provider active.
    await writeFile(
      configPath,
      `${OPENROUTER_ROOT_CONFIG}\n${trustedConfig.trim()}\n\n${openRouterTableConfig(options.broker.baseUrl)}`,
      {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      },
    );
    await chmod(configPath, PRIVATE_FILE_MODE);
    return {
      ...profile,
      async dispose() {
        await profile.dispose();
      },
    };
  } catch (error) {
    await profile.dispose();
    throw error;
  }
}
